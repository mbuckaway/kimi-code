import { Service } from '#/_base/di/service';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  rootDelegationExtras,
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { isProviderRateLimitError } from '#/kosong/contract/errors';
import { isProviderUsageLimitError } from '#/kosong/protocol/errors';
import { ILogService } from '#/_base/log/log';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { type IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { scopeGitContextProcess } from '#/session/agentLifecycle/profile/gitContext';
import {
  isSubagentMeta,
  ownMeta,
  subagentChildrenIndex,
  subagentDescendantsChildFirst,
  tagsOf,
} from '#/session/agentLifecycle/subagentMetadata';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { agentNameOf, normalizeAgentName } from './agentNames';
import { AGENT_PERSONA_FLAG_ID } from './flag';
import { type ResolvedPersona, resolvePersona } from './persona';

import {
  type AgentLabelUpdate,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  type DismissAgentsResult,
  type DismissAgentsTargets,
  type DismissedAgent,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';
import { runAgentTurn } from './runAgentTurn';
import {
  resolveSubagentBinding,
  resolveSubagentThinking,
  wrapSubagentModelError,
} from './configSection';
import {
  DEFAULT_PROFILE_NAME,
  FORK_CONTEXT_NOTICE,
  PERSONA_EXPERIMENTAL_UNAVAILABLE,
  PERSONA_WITH_FORK_UNAVAILABLE,
  type SpawnSubagentOptions,
  type SpawnedSubagent,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from './spawn';

interface OwnedAgentTarget {
  readonly agentId: string;
  readonly meta: AgentMeta;
}

interface AgentTreeIndex {
  readonly agents: Readonly<Record<string, AgentMeta>>;
  readonly children: ReadonlyMap<string, readonly string[]>;
}

export const FINISHED_SUBAGENT_LIMIT_ENV = 'KIMI_CODE_AGENT_FINISHED_SUBAGENT_LIMIT';
export const DEFAULT_FINISHED_SUBAGENT_LIMIT = 64;
export const DISABLED_FINISHED_SUBAGENT_LIMIT = 0;

const UNAVAILABLE_GIT_PROCESS: IHostProcessService = {
  _serviceBrand: undefined,
  spawn: () => Promise.reject(new Error('git context requires a process-capable runtime')),
};

export interface FinishedAgentLifecycle {
  handleOf(agentId: string): IAgentScopeHandle | undefined;
  remove(agentId: string): Promise<void>;
}

export class FinishedSubagentRetention {
  private readonly finished = new Map<string, number>();
  private evictionChain: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(private readonly limit: number = DEFAULT_FINISHED_SUBAGENT_LIMIT) {}

  get size(): number {
    return this.finished.size;
  }

  markFinished(agentId: string): void {
    if (this.limit <= DISABLED_FINISHED_SUBAGENT_LIMIT) return;
    this.finished.delete(agentId);
    this.finished.set(agentId, ++this.sequence);
  }

  forget(agentId: string): void {
    this.finished.delete(agentId);
  }

  evictExcess(
    lifecycle: FinishedAgentLifecycle,
    isBusy: (handle: IAgentScopeHandle) => boolean,
  ): Promise<readonly string[]> {
    const eviction = this.evictionChain.then(() => this.evictExcessNow(lifecycle, isBusy));
    this.evictionChain = eviction.then(
      () => undefined,
      () => undefined,
    );
    return eviction;
  }

  private async evictExcessNow(
    lifecycle: FinishedAgentLifecycle,
    isBusy: (handle: IAgentScopeHandle) => boolean,
  ): Promise<readonly string[]> {
    const evicted: string[] = [];
    if (this.limit <= DISABLED_FINISHED_SUBAGENT_LIMIT) return evicted;

    let failure: { readonly error: unknown } | undefined;
    for (const [agentId, sequence] of Array.from(this.finished.entries())) {
      if (this.finished.size <= this.limit) break;
      if (this.finished.get(agentId) !== sequence) continue;
      const handle = lifecycle.handleOf(agentId);
      if (handle === undefined) {
        this.finished.delete(agentId);
        continue;
      }
      if (isBusy(handle)) continue;
      try {
        await lifecycle.remove(agentId);
      } catch (error) {
        failure ??= { error };
        continue;
      }
      if (this.finished.get(agentId) === sequence) this.finished.delete(agentId);
      evicted.push(agentId);
    }
    if (failure !== undefined) throw failure.error;
    return evicted;
  }
}

export function resolveFinishedSubagentLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[FINISHED_SUBAGENT_LIMIT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_FINISHED_SUBAGENT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `${FINISHED_SUBAGENT_LIMIT_ENV} must be an integer, got ${JSON.stringify(raw)}.`,
      { details: { value: raw } },
    );
  }
  return value < 1 ? DISABLED_FINISHED_SUBAGENT_LIMIT : value;
}

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private readonly reservedAgentNames = new Map<string, symbol>();
  private readonly finishedRetention = new FinishedSubagentRetention(
    resolveFinishedSubagentLimit(),
  );

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @ISessionWorkspaceContext private readonly workspaceContext: ISessionWorkspaceContext,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {
    super();
  }

  run(agent: AgentContext, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.agentLifecycle.handleOf(agent.agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agent.agentId}" does not exist`, {
        details: { agentId: agent.agentId },
      });
    }
    const run = runAgentTurn(handle, request, {
      summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
      signal: opts.signal,
      onReady: opts.onReady,
    });
    void run.then(
      (started) => {
        this.trackFinishedRun(agent.agentId, started.completion);
      },
      () => {
        this.onAgentRunFinished(agent.agentId);
      },
    );
    return run;
  }

  private trackFinishedRun(agentId: string, completion: Promise<unknown>): void {
    void completion.then(
      () => {
        this.onAgentRunFinished(agentId);
      },
      (error: unknown) => {
        if (isProviderUsageLimitError(error) || !isProviderRateLimitError(error)) {
          this.onAgentRunFinished(agentId);
        }
      },
    );
  }

  private onAgentRunFinished(agentId: string): void {
    if (agentId === MAIN_AGENT_ID) return;
    this.finishedRetention.markFinished(agentId);
    void this.finishedRetention
      .evictExcess(
        {
          handleOf: (targetId) => this.agentLifecycle.handleOf(targetId),
          remove: async (targetId) => {
            const target = this.agentLifecycle.handleOf(targetId);
            if (target === undefined) return;
            await this.agentLifecycle.remove(agentContextOf(target));
          },
        },
        (target) => isFinishedAgentBusy(target),
      )
      .catch((error: unknown) => {
        this.log.warn('finished subagent eviction failed', { agentId, error });
      });
  }

  async planSpawn(input: SubagentSpawnPlanInput): Promise<SubagentSpawnPlan> {
    const caller = this.requireCaller(input.callerAgentId);
    const fork = input.fork === true;
    await this.catalog.ready;
    const own = caller.accessor.get(IAgentProfileService).data();
    const requested = input.profileName !== undefined && input.profileName.length > 0
      ? input.profileName
      : undefined;
    const persona =
      input.persona === undefined
        ? undefined
        : await this.resolvePersonaForSpawn(input.persona, requested, fork);
    const requestedProfileName =
      requested ??
      persona?.base ??
      (fork ? (own.profileName ?? DEFAULT_PROFILE_NAME) : DEFAULT_PROFILE_NAME);
    const extras =
      input.callerAgentId === MAIN_AGENT_ID
        ? rootDelegationExtras(this.catalog, own, this.catalog.list())
        : undefined;
    let allowlist = subagentAllowlistFor(this.catalog, own, extras);
    if (allowlist !== undefined && own.subagents === undefined) {
      allowlist = withoutDelegatingTargets(this.catalog, allowlist);
    }
    if (!fork && allowlist !== undefined && !allowlist.includes(requestedProfileName)) {
      throw new Error2(
        ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
        subagentTypeNotAllowedMessage(requestedProfileName, allowlist),
        { details: { profileName: requestedProfileName, allowlist } },
      );
    }
    const profile = this.catalog.get(requestedProfileName);
    if (!fork && profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${requestedProfileName}"`, {
        details: { profileName: requestedProfileName },
      });
    }
    if (own.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: input.callerAgentId },
      });
    }
    const binding = fork
      ? { model: own.modelAlias, thinking: own.thinkingLevel }
      : resolveSubagentBinding(
          this.configService,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          input.model,
        );
    let model: Model;
    try {
      model = this.modelCatalog.get(binding.model);
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, own.modelAlias);
    }
    return {
      profileName: profile?.name ?? requestedProfileName,
      model: binding.model,
      thinking: resolveSubagentThinking(this.configService, model, binding.thinking),
      fork,
      persona,
    };
  }

  private async resolvePersonaForSpawn(
    reference: string,
    baseProfileName: string | undefined,
    fork: boolean,
  ): Promise<ResolvedPersona> {
    if (fork) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, PERSONA_WITH_FORK_UNAVAILABLE);
    }
    if (!this.flags.enabled(AGENT_PERSONA_FLAG_ID)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, PERSONA_EXPERIMENTAL_UNAVAILABLE);
    }
    return resolvePersona({
      reference,
      baseProfileName,
      catalog: this.catalog,
      fs: this.hostFs,
      workspace: this.workspaceContext,
    });
  }

  async spawn(opts: SpawnSubagentOptions): Promise<SpawnedSubagent> {
    const caller = this.requireCaller(opts.callerAgentId);
    const name = opts.name === undefined ? undefined : normalizeAgentName(opts.name);
    let releaseName: (() => void) | undefined;
    if (name !== undefined) {
      releaseName = this.reserveAgentName(name);
    }
    try {
      if (name !== undefined) await this.assertAgentNameFree(name);
      return await this.createSpawnedAgent(caller, opts, name);
    } finally {
      releaseName?.();
    }
  }

  async dismissAgents(
    callerAgentId: string,
    targets: DismissAgentsTargets,
  ): Promise<DismissAgentsResult> {
    const resolved = await this.resolveDismissTargets(callerAgentId, targets);
    const dismissed: DismissedAgent[] = [];
    for (const { agentId, meta } of resolved) {
      this.finishedRetention.forget(agentId);
      const handle = this.agentLifecycle.handleOf(agentId);
      if (handle !== undefined) await this.agentLifecycle.remove(agentContextOf(handle));
      await this.sessionMetadata.unregisterAgent(agentId);
      dismissed.push({ agentId, name: agentNameOf(meta), ghost: handle === undefined });
    }
    return { dismissed };
  }

  async setAgentTags(
    callerAgentId: string,
    target: string,
    tags: readonly string[],
  ): Promise<AgentLabelUpdate> {
    const { agentId, meta } = await this.resolveOwnedTarget(callerAgentId, target);
    const normalized = normalizeAgentTags(tags);
    const labels: Record<string, string> = { ...meta.labels };
    if (normalized.length === 0) {
      delete labels['tags'];
    } else {
      labels['tags'] = normalized.join(',');
    }
    const nextMeta: AgentMeta = { ...meta, labels };
    await this.sessionMetadata.registerAgent(agentId, nextMeta);
    return { agentId, name: agentNameOf(nextMeta), tags: normalized };
  }

  async renameAgent(
    callerAgentId: string,
    target: string,
    name: string,
  ): Promise<AgentLabelUpdate> {
    const { agentId, meta } = await this.resolveOwnedTarget(callerAgentId, target);
    const normalized = normalizeAgentName(name);
    if (agentNameOf(meta) === normalized) {
      return { agentId, name: normalized, tags: tagsOf(meta) };
    }
    const release = this.reserveAgentName(normalized);
    try {
      await this.assertAgentNameAvailable(normalized, agentId);
      const nextMeta: AgentMeta = { ...meta, labels: { ...meta.labels, name: normalized } };
      await this.sessionMetadata.registerAgent(agentId, nextMeta);
      return { agentId, name: normalized, tags: tagsOf(meta) };
    } finally {
      release();
    }
  }

  async assertOwned(callerAgentId: string, target: string): Promise<void> {
    await this.resolveOwnedTarget(callerAgentId, target);
  }

  private async createSpawnedAgent(
    caller: IAgentScopeHandle,
    opts: SpawnSubagentOptions,
    name: string | undefined,
  ): Promise<SpawnedSubagent> {
    const { plan } = opts;
    const labels = name === undefined ? opts.labels : { ...opts.labels, name };
    const lease = plan.fork
      ? undefined
      : caller.accessor.get(IAgentRuntimeService).acquire(['process']);
    try {
      let created: IAgentScopeHandle;
      try {
        if (plan.fork) {
          const forked = await this.agentLifecycle.fork(agentContextOf(caller), {
            labels,
          });
          created = this.agentLifecycle.handleOf(forked.agentId)!;
        } else {
          const createdContext = await this.agentLifecycle.create({
            binding: {
              profile: plan.profileName,
              model: plan.model,
              thinking: plan.thinking,
              persona: plan.persona,
            },
            labels,
            runtimeId: lease!.runtime.identity.runtimeId,
          });
          created = this.agentLifecycle.handleOf(createdContext.agentId)!;
        }
      } catch (error) {
        throw wrapSubagentModelError(
          error,
          plan.model,
          caller.accessor.get(IAgentProfileService).data().modelAlias,
        );
      }
      if (name !== undefined) {
        try {
          await this.assertAgentNameWon(name, created.id);
        } catch (error) {
          await this.discardAgent(created);
          throw error;
        }
      }
      created.accessor
        .get(IAgentPermissionModeService)
        .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
      const createdUserTools = created.accessor.get(IAgentUserToolService);
      const callerUserTools = caller.accessor.get(IAgentUserToolService);
      if (plan.fork) {
        const activeToolNames = created.accessor.get(IAgentProfileService).getActiveToolNames();
        createdUserTools.inheritUserTools(callerUserTools, activeToolNames);
      } else {
        createdUserTools.inheritUserTools(callerUserTools);
      }
      const promptText = plan.fork
        ? `${FORK_CONTEXT_NOTICE}\n\n${opts.prompt}`
        : await this.applyPromptPrefix(plan.profileName, opts.prompt, lease!.runtime);
      return {
        agentId: created.id,
        profileName: plan.profileName,
        model: plan.model,
        promptText,
      };
    } finally {
      lease?.dispose();
    }
  }

  private async assertAgentNameFree(name: string): Promise<void> {
    const holder = this.findNameHolder(await this.agentMetadata(), name);
    if (holder !== undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NAME_TAKEN,
        `An agent named "${name}" already exists (${holder}).`,
      );
    }
  }

  private async assertAgentNameWon(name: string, agentId: string): Promise<void> {
    const agents = await this.agentMetadata();
    for (const [holderId, meta] of Object.entries(agents)) {
      if (holderId === agentId || meta.type !== 'sub' || agentNameOf(meta) !== name) continue;
      if (holderId.localeCompare(agentId, undefined, { numeric: true }) < 0) {
        throw new Error2(
          ErrorCodes.AGENT_NAME_TAKEN,
          `An agent named "${name}" already exists (${holderId}).`,
        );
      }
    }
  }

  private async assertAgentNameAvailable(name: string, excludeAgentId: string): Promise<void> {
    const holder = this.findNameHolder(await this.agentMetadata(), name, excludeAgentId);
    if (holder !== undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NAME_TAKEN,
        `An agent named "${name}" already exists (${holder}).`,
      );
    }
  }

  private async resolveDismissTargets(
    callerAgentId: string,
    targets: DismissAgentsTargets,
  ): Promise<readonly OwnedAgentTarget[]> {
    const index = await this.agentTreeIndex();
    const resolved: OwnedAgentTarget[] = [];
    const seen = new Set<string>();
    const pushSubtree = (target: OwnedAgentTarget): void => {
      for (const descendantId of subagentDescendantsChildFirst(target.agentId, index.children)) {
        if (seen.has(descendantId)) continue;
        const meta = ownMeta(index.agents, descendantId);
        if (meta === undefined) continue;
        seen.add(descendantId);
        resolved.push({ agentId: descendantId, meta });
      }
      if (seen.has(target.agentId)) return;
      seen.add(target.agentId);
      resolved.push(target);
    };
    for (const target of [...(targets.ids ?? []), ...(targets.names ?? [])]) {
      pushSubtree(await this.resolveOwnedTarget(callerAgentId, target, index));
    }
    if (targets.all === true) {
      for (const [agentId, meta] of this.ownedChildren(index, callerAgentId)) {
        pushSubtree({ agentId, meta });
      }
    }
    return resolved;
  }

  private ownedChildren(
    index: AgentTreeIndex,
    callerAgentId: string,
  ): readonly (readonly [string, AgentMeta])[] {
    return (index.children.get(callerAgentId) ?? []).flatMap((agentId) => {
      const meta = ownMeta(index.agents, agentId);
      return meta === undefined || !isSubagentMeta(meta) ? [] : [[agentId, meta] as const];
    });
  }

  private async agentTreeIndex(): Promise<AgentTreeIndex> {
    const agents = await this.agentMetadata();
    return { agents, children: subagentChildrenIndex(agents) };
  }

  private async resolveOwnedTarget(
    callerAgentId: string,
    target: string,
    index?: AgentTreeIndex,
  ): Promise<OwnedAgentTarget> {
    const address = target.trim();
    if (address === MAIN_AGENT_ID) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_A_SUBAGENT,
        `The root agent "${MAIN_AGENT_ID}" is not a subagent.`,
        { details: { agentId: MAIN_AGENT_ID } },
      );
    }
    if (address === callerAgentId) {
      throw new Error2(ErrorCodes.AGENT_NOT_OWNED, 'An agent cannot target itself.');
    }
    const resolvedIndex = index ?? (await this.agentTreeIndex());
    const subtree = new Set(
      subagentDescendantsChildFirst(callerAgentId, resolvedIndex.children),
    );
    const direct = ownMeta(resolvedIndex.agents, address);
    if (direct !== undefined) {
      if (direct.type === 'main') {
        throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent "${address}" is not a subagent.`, {
          details: { agentId: address },
        });
      }
      if (!subtree.has(address)) {
        throw new Error2(
          ErrorCodes.AGENT_NOT_OWNED,
          `Agent "${address}" is not owned by "${callerAgentId}".`,
          { details: { agentId: address } },
        );
      }
      return { agentId: address, meta: direct };
    }
    const named = [...subtree]
      .map((agentId) => ({ agentId, meta: ownMeta(resolvedIndex.agents, agentId) }))
      .filter(
        (entry): entry is OwnedAgentTarget =>
          entry.meta !== undefined && agentNameOf(entry.meta) === address,
      )
      .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
    const match = named[0];
    if (match === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${address}" does not exist.`, {
        details: { agentId: address },
      });
    }
    return match;
  }

  private findNameHolder(
    agents: Readonly<Record<string, AgentMeta>>,
    name: string,
    excludeAgentId?: string,
  ): string | undefined {
    for (const [holderId, meta] of Object.entries(agents)) {
      if (holderId === excludeAgentId) continue;
      if (meta.type === 'sub' && agentNameOf(meta) === name) return holderId;
    }
    return undefined;
  }

  private reserveAgentName(name: string): () => void {
    if (this.reservedAgentNames.has(name)) {
      throw new Error2(
        ErrorCodes.AGENT_NAME_TAKEN,
        `An agent named "${name}" is already reserved by an in-flight spawn.`,
      );
    }
    const token = Symbol(name);
    this.reservedAgentNames.set(name, token);
    return () => {
      if (this.reservedAgentNames.get(name) === token) this.reservedAgentNames.delete(name);
    };
  }

  private async discardAgent(created: IAgentScopeHandle): Promise<void> {
    this.finishedRetention.forget(created.id);
    await this.agentLifecycle.remove(agentContextOf(created));
    await this.sessionMetadata.unregisterAgent(created.id);
  }

  private async agentMetadata(): Promise<Readonly<Record<string, AgentMeta>>> {
    return (await this.sessionMetadata.read()).agents ?? {};
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  private async applyPromptPrefix(
    profileName: string,
    prompt: string,
    runtime: Runtime,
  ): Promise<string> {
    const profile = this.catalog.get(profileName);
    if (profile?.promptPrefix === undefined) return prompt;
    const view = new RuntimeWorkspaceView(runtime, {
      workDir: this.sessionContext.cwd,
    });
    const identity = runtime.identity;
    const process = runtime.process;
    return applyProfilePromptPrefix(profile, prompt, {
      cwd: view.workDir,
      process:
        process === undefined
          ? UNAVAILABLE_GIT_PROCESS
          : scopeGitContextProcess(
              process,
              `${identity.workspaceId}\0${identity.runtimeId}\0${identity.generation}`,
            ),
      log: this.log,
    });
  }

  private requireCaller(agentId: string): IAgentScopeHandle {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }

  private summaryPolicyFor(handle: IAgentScopeHandle): AgentProfileSummaryPolicy | undefined {
    const profileName = handle.accessor.get(IAgentProfileService).data().profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName)?.summaryPolicy;
  }
}

function normalizeAgentTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

function isFinishedAgentBusy(handle: IAgentScopeHandle): boolean {
  const status = handle.accessor.get(IAgentLoopService).status();
  return status.state !== 'idle' || status.pendingTurnIds.length > 0 || status.hasPendingRequests;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
