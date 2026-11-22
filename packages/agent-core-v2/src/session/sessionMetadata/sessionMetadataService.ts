import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
  type SessionMetadataChangedEvent,
  type SessionMetaPatch,
  type SessionTitleKind,
} from './sessionMetadata';

const META_KEY = 'state.json';

const MAX_DRAIN_ITERATIONS = 100;

const pendingWrites = new Set<Promise<void>>();

export async function drainSessionMetadataWrites(): Promise<void> {
  for (let iteration = 0; iteration < MAX_DRAIN_ITERATIONS; iteration += 1) {
    if (pendingWrites.size === 0) return;
    await Promise.all(pendingWrites);
  }
  await Promise.all(pendingWrites);
}

type AgentsIntent =
  | { readonly op: 'set'; readonly agentId: string; readonly meta: AgentMeta }
  | { readonly op: 'remove'; readonly agentId: string };

interface QueueSettlement {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface WorkTask {
  readonly kind: 'work';
  readonly run: () => Promise<void>;
}

interface AgentsTask {
  readonly kind: 'agents';
  readonly intents: AgentsIntent[];
  readonly settlements: QueueSettlement[];
}

type QueueTask = WorkTask | AgentsTask;

export const sessionMetadataDataKey = defineState<SessionMeta | undefined>(
  'sessionMetadata.data',
  () => undefined,
);

export class SessionMetadata extends Service implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;

  private disposed = false;
  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;

  private readonly _onDidChangeMetadata = this._register(
    new Emitter<SessionMetadataChangedEvent>(),
  );
  private readonly scope: string;
  private readonly tasks: QueueTask[] = [];
  private draining = false;
  private drainScheduled = false;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
  ) {
    super();
    this._register({
      dispose: () => {
        this.disposed = true;
      },
    });
    this.states.contributeState(sessionMetadataDataKey);
    this.scope = ctx.metaScope;
    this.onDidChangeMetadata = this._onDidChangeMetadata.event;
    this.ready = this.load();
  }

  private get data(): SessionMeta {
    return this.states.get(sessionMetadataDataKey) as SessionMeta;
  }

  private set data(value: SessionMeta) {
    this.states.set(sessionMetadataDataKey, value);
  }

  async read(): Promise<SessionMeta> {
    await this.ready;
    return this.data;
  }

  async update(
    patch: SessionMetaPatch,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): Promise<void> {
    return this.enqueueUpdate(async () => {
      await this.applyUpdate(patch, opts);
    });
  }

  private async applyUpdate(
    patch: SessionMetaPatch,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): Promise<boolean> {
    await this.ready;
    if (this.disposed) return false;
    const updatedAt =
      patch.updatedAt ?? (opts?.touchUpdatedAt === false ? this.data.updatedAt : Date.now());
    const previous = this.data;
    const next: SessionMeta = { ...previous, ...patch, updatedAt };
    if (metadataValueEquals(previous, next)) return false;
    this.data = next;
    try {
      await this.persist();
    } catch (error) {
      this.data = previous;
      throw error;
    }
    if (this.disposed) return false;
    this.mirrorToReadModel();
    this._onDidChangeMetadata.fire({
      changed: Object.keys(patch) as (keyof SessionMeta)[],
    });
    return true;
  }

  async setTitle(title: string): Promise<void> {
    await this.update({ title, titleKind: 'custom' }, { touchUpdatedAt: false });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    return this.enqueueUpdate(async () => {
      await this.ready;
      if (opts?.force !== true && this.data.titleKind === 'custom') return false;
      if (this.data.title === title && this.data.titleKind === 'generated') return true;
      return this.applyUpdate({ title, titleKind: 'generated' }, { touchUpdatedAt: false });
    });
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.enqueueUpdate(async () => {
      await this.ready;
      const archivedAt = archived ? (this.data.archivedAt ?? Date.now()) : undefined;
      await this.applyUpdate({ archived, archivedAt }, { touchUpdatedAt: false });
    });
  }

  registerAgent(agentId: string, meta: AgentMeta): Promise<void> {
    return this.enqueueAgentsTask({ op: 'set', agentId, meta });
  }

  unregisterAgent(agentId: string): Promise<void> {
    return this.enqueueAgentsTask({ op: 'remove', agentId });
  }

  private enqueueUpdate<T>(work: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.tasks.push({
        kind: 'work',
        run: async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
    this.trackPending(result);
    this.scheduleDrain();
    return result;
  }

  private enqueueAgentsTask(intent: AgentsIntent): Promise<void> {
    const last = this.tasks[this.tasks.length - 1];
    let task: AgentsTask;
    if (last !== undefined && last.kind === 'agents') {
      task = last;
    } else {
      task = { kind: 'agents', intents: [], settlements: [] };
      this.tasks.push(task);
    }
    task.intents.push(intent);
    const result = new Promise<void>((resolve, reject) => {
      task.settlements.push({ resolve, reject });
    });
    this.trackPending(result);
    this.scheduleDrain();
    return result;
  }

  private trackPending(result: Promise<unknown>): void {
    const tracked: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.add(tracked);
    void tracked.finally(() => pendingWrites.delete(tracked));
  }

  private scheduleDrain(): void {
    if (this.draining || this.drainScheduled) return;
    this.drainScheduled = true;
    void Promise.resolve()
      .then(() => {
        this.drainScheduled = false;
        return this.drainTasks();
      })
      .catch((error: unknown) => {
        this.drainScheduled = false;
        this.draining = false;
        this.log.warn('session metadata drain failed; rescheduling the queued writes', {
          sessionId: this.ctx.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.tasks.length > 0) this.scheduleDrain();
      });
  }

  private async drainTasks(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let task = this.tasks.shift();
      while (task !== undefined) {
        await this.runTask(task);
        task = this.tasks.shift();
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: QueueTask): Promise<void> {
    if (task.kind === 'work') {
      await task.run();
      return;
    }
    let failure: { readonly error: unknown } | undefined;
    try {
      await this.applyAgentsIntents(task.intents);
    } catch (error) {
      failure = { error };
    }
    for (const settlement of task.settlements) {
      if (failure === undefined) settlement.resolve();
      else settlement.reject(failure.error);
    }
  }

  private async applyAgentsIntents(intents: readonly AgentsIntent[]): Promise<void> {
    await this.ready;
    if (this.disposed) return;
    const previous = this.data;
    const agents: Record<string, AgentMeta> = { ...previous.agents };
    for (const intent of intents) {
      if (intent.op === 'set') {
        agents[intent.agentId] = intent.meta;
      } else {
        delete agents[intent.agentId];
      }
    }
    if (agentMapsEqual(previous.agents, agents)) return;
    this.data = { ...previous, agents };
    try {
      await this.persist();
    } catch (error) {
      this.data = previous;
      throw error;
    }
    if (this.disposed) return;
    this.mirrorToReadModel();
    this._onDidChangeMetadata.fire({ changed: ['agents'] });
  }

  private async persist(): Promise<void> {
    const write = this.store.set(this.scope, META_KEY, encodeSessionMeta(this.data));
    this.trackPending(write);
    await write;
  }

  private mirrorToReadModel(): void {
    try {
      this.mirror.record(
        buildSessionSummary({
          id: this.data.id,
          workspaceId: this.ctx.workspaceId,
          cwd: this.ctx.cwd,
          title: this.data.title,
          lastPrompt: this.data.lastPrompt,
          createdAt: this.data.createdAt,
          updatedAt: this.data.updatedAt,
          archived: this.data.archived === true,
          archivedAt: this.data.archivedAt,
          custom: this.data.custom,
          lastTurnReason: this.data.lastTurnReason,
        }),
      );
    } catch (error) {
      this.log.warn('session index mirror record failed; the read model heals by reconciliation', {
        sessionId: this.ctx.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async load(): Promise<void> {
    const existing = await this.store.get<SessionMeta>(this.scope, META_KEY);
    if (existing !== undefined) {
      this.data = normalizeSessionMeta(existing, this.ctx.sessionId);
      if (
        this.data.agents === undefined ||
        this.data.custom === undefined ||
        sessionMetaTitleNeedsMigration(existing, this.data)
      ) {
        this.data = {
          ...this.data,
          agents: this.data.agents ?? {},
          custom: this.data.custom ?? {},
        };
        await this.persist();
      }
      return;
    }
    const now = Date.now();
    this.data = {
      id: this.ctx.sessionId,
      version: SESSION_META_VERSION,
      cwd: this.ctx.cwd,
      createdAt: now,
      updatedAt: now,
      archived: false,
      agents: {},
      custom: {},
    };
    await this.persist();
    this.mirrorToReadModel();
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

function metadataValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => metadataValueEquals(item, b[index]));
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
  const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(([key, value]) => metadataValueEquals(value, b[key]));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function agentMetaEquals(a: AgentMeta, b: AgentMeta): boolean {
  return (
    a.homedir === b.homedir &&
    a.type === b.type &&
    (a.parentAgentId ?? null) === (b.parentAgentId ?? null) &&
    a.forkedFrom === b.forkedFrom &&
    a.swarmItem === b.swarmItem &&
    recordEquals(a.labels, b.labels)
  );
}

function agentMapsEqual(
  previous: Readonly<Record<string, AgentMeta>> | undefined,
  next: Readonly<Record<string, AgentMeta>>,
): boolean {
  const previousEntries = Object.entries(previous ?? {});
  const nextEntries = Object.entries(next);
  if (previousEntries.length !== nextEntries.length) return false;
  return previousEntries.every(([agentId, meta]) => {
    const nextMeta = next[agentId];
    return nextMeta !== undefined && agentMetaEquals(meta, nextMeta);
  });
}

function recordEquals(a: AgentMeta['labels'], b: AgentMeta['labels']): boolean {
  const entriesA = Object.entries(a ?? {});
  const entriesB = Object.entries(b ?? {});
  return (
    entriesA.length === entriesB.length && entriesA.every(([key, value]) => b?.[key] === value)
  );
}

export function normalizeSessionMeta(raw: SessionMeta, sessionId: string): SessionMeta {
  const legacy = raw as unknown as LegacySessionMeta;
  const normalizedTitle = normalizeSessionTitle(legacy);
  const {
    createdAt: legacyCreatedAt,
    updatedAt: legacyUpdatedAt,
    workDir: legacyWorkDir,
    titleSource: _legacyTitleSource,
    isCustomTitle: _legacyIsCustomTitle,
    customTitle: _legacyCustomTitle,
    ...clean
  } = legacy;
  const cwd =
    clean.cwd ?? (typeof legacyWorkDir === 'string' && legacyWorkDir.length > 0
      ? legacyWorkDir
      : undefined);
  const { title, titleKind } = normalizedTitle;
  return {
    ...clean,
    id: clean.version === SESSION_META_VERSION ? clean.id : sessionId,
    version: SESSION_META_VERSION,
    cwd,
    title,
    titleKind,
    createdAt: toEpochMs(legacyCreatedAt),
    updatedAt: toEpochMs(legacyUpdatedAt),
    archived: clean.archived === true,
  };
}

type LegacySessionMeta = Omit<SessionMeta, 'createdAt' | 'updatedAt'> & {
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly workDir?: unknown;
  readonly titleSource?: unknown;
  readonly isCustomTitle?: unknown;
  readonly customTitle?: unknown;
};

function normalizeSessionTitle(
  raw: LegacySessionMeta,
): Pick<SessionMeta, 'title' | 'titleKind'> {
  const title = typeof raw.title === 'string' ? raw.title : undefined;
  if (title !== undefined && raw.isCustomTitle === true) {
    return { title, titleKind: 'custom' };
  }
  if (title !== undefined && isSessionTitleKind(raw.titleKind)) {
    return { title, titleKind: raw.titleKind };
  }
  if (title !== undefined && raw.isCustomTitle === false) {
    return { title, titleKind: 'replaceable' };
  }
  if (typeof raw.customTitle === 'string') {
    return { title: raw.customTitle, titleKind: 'custom' };
  }
  return title === undefined ? {} : { title, titleKind: 'replaceable' };
}

function isSessionTitleKind(value: unknown): value is SessionTitleKind {
  return value === 'replaceable' || value === 'generated' || value === 'custom';
}

type PersistedSessionMeta = SessionMeta & { readonly isCustomTitle: boolean };

export function encodeSessionMeta(meta: SessionMeta): PersistedSessionMeta {
  return { ...meta, isCustomTitle: meta.titleKind === 'custom' };
}

function sessionMetaTitleNeedsMigration(raw: SessionMeta, normalized: SessionMeta): boolean {
  const record = raw as unknown as Record<string, unknown>;
  return (
    raw.title !== normalized.title ||
    raw.titleKind !== normalized.titleKind ||
    record['isCustomTitle'] !== (normalized.titleKind === 'custom') ||
    Object.hasOwn(record, 'titleSource') ||
    Object.hasOwn(record, 'customTitle')
  );
}

export function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetadata,
  SessionMetadata,
  ScopeActivation.OnScopeCreated,
  'sessionMetadata',
);
