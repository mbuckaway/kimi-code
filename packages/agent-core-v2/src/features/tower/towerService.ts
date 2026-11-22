import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { profileKey } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isUntitled } from '#/session/sessionMetadata/promptMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { TowerModeInjection } from './injection/towerModeInjection';
import {
  STATE_FILE,
  TowerProtocolError,
  TowerStore,
  WORKTREES_DIR,
  branchExists,
  checkoutNewLocalBranch,
  commitPaths,
  listBaseDirtyEntries,
  resolveTowerRepoRoot,
} from './protocol/index';
import {
  analyzeTowerBashCommand,
  commandNeedsTowerGuard,
  TOWER_BASH_GUARD_PARSE_OPTIONS,
  towerWorkspaceOwned,
} from './bashGuard';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
  type TowerEnterResult,
  type TowerExitReason,
} from './tower';
import { isTowerFeatureAssembled } from './towerFeature';
import { TowerModeEnter, TowerModeExit, towerKey, towerOwnerKey } from './towerOps';

export const TOWER_MODE_TOOLS: readonly string[] = ['TowerInit', ...TOWER_TOOL_NAMES];

export const TOWER_VETO_TOOL_NAMES: readonly string[] = ['TowerComplete', ...TOWER_MODE_TOOLS];

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @IFeatureManager featureManager: IFeatureManager,
    @IConfigService config: IConfigService,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IEventBus eventBus: IEventBus,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {
    super();
    this.agentState.contributeState(towerKey);
    this.agentState.contributeState(towerOwnerKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('tower', async (_ctx, next) => {
        await this.reconcileForeignTower();
        this.restoreTowerTools();
        this.reconcileTowerProjection();
        await next();
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!TOWER_VETO_TOOL_NAMES.includes(event.toolCall.name)) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'The tower experiment is disabled — tower tools are inert. Re-enable the experiment (a restart is required if it was just turned on) before driving the tower protocol.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        const toolName = event.toolCall.name;
        if (toolName !== 'Write' && toolName !== 'Edit') return;
        if (this.agentState.get(profileKey).profileName !== TOWER_WORKER_PROFILE) return;

        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const entry = await store
          .load()
          .then(
            (state) =>
              state.roster.agents.find((agent) => agent.agentId === this.agentCtx.agentId),
            () => undefined,
          );
        const slot = entry?.worktree;
        if (slot === undefined) return;
        const worktree = store.abs(join(WORKTREES_DIR, slot));

        const escapes = (event.execution.accesses ?? [])
          .filter(
            (access): access is ToolFileAccess =>
              access.kind === 'file' &&
              (access.operation === 'write' || access.operation === 'readwrite'),
          )
          .filter((access) => !isWithinDirectory(access.path, worktree));
        if (escapes.length === 0) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                `${escapes.map((access) => access.path).join(', ')}. ` +
                'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (event.toolCall.name !== 'Bash') return;
        const command = stringArg(event.args, 'command');
        if (command === undefined || !commandNeedsTowerGuard(command)) return;
        const mainCheckout = resolveTowerRepoRoot(this.sessionCtx.cwd);
        if (!(await towerWorkspaceOwned(join(mainCheckout, STATE_FILE)))) return;
        const cwdArg = stringArg(event.args, 'cwd');
        const cwd =
          cwdArg === undefined ? this.workspaceCtx.workDir : this.resolveBashGuardCwd(cwdArg);
        const reason = analyzeTowerBashCommand({ command, cwd, mainCheckout }, (source) =>
          this.bashParser.parse(source, TOWER_BASH_GUARD_PARSE_OPTIONS),
        );
        if (reason === undefined) return;
        event.veto(denyToolExecution(this.toolApproval.formatDenyMessage(reason)));
      }),
    );
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (featureManager !== undefined) {
      this._register(
        featureManager.onDidChangeUnits(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    if (config !== undefined) {
      this._register(
        config.onDidChangeConfiguration(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        const active = this.profile.getActiveToolNames();
        if (active === undefined) return;
        if (TOWER_MODE_TOOLS.every((name) => active.includes(name))) return;
        this.addTowerTools();
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }),
        );
      }),
    );
    this._register(
      activateReminderWhenReady(agentLifecycle, this.agentCtx, (reminder) =>
        new TowerModeInjection(reminder, this, context, this.flags),
      ),
    );
    this._register(
      eventBus.subscribe(TaskTerminatedNotice, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        const info = event.info;
        if (info.kind !== 'agent') return;
        if (info.agentId === undefined) return;
        if (info.status === 'completed') return;
        void this.markAgentDied(info.agentId, info.status, info.stopReason);
      }),
    );
    this._register(
      eventBus.subscribe(SubagentStarted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        void this.clearAgentDied(event.subagentId);
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'TodoList') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
            ),
          ),
        );
      }),
    );
  }

  private resolveBashGuardCwd(cwdArg: string): string {
    return this.workspaceCtx.resolve(cwdArg);
  }

  private readonly addedTowerTools = new Set<string>();
  private modeOperation: Promise<unknown> = Promise.resolve();

  private serializeModeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.modeOperation.then(operation, operation);
    this.modeOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async enter(base?: string): Promise<TowerEnterResult> {
    return this.serializeModeOperation(() => this.enterInternal(base));
  }

  private async enterInternal(base?: string): Promise<TowerEnterResult> {
    if (this.agentCtx.agentId !== 'main') return { entered: false, reason: 'not-main-agent' };
    if (!this.flags.enabled(TOWER_FLAG_ID)) return { entered: false, reason: 'experiment-off' };
    if (!isTowerFeatureAssembled(this.flags)) {
      return { entered: false, reason: 'feature-not-assembled' };
    }
    const owner = await this.resolveTowerOwner();
    if (owner !== undefined && owner !== this.sessionCtx.sessionId) {
      const ownerHandle = this.sessions.get(owner);
      if (ownerHandle !== undefined) {
        const activity = ownerHandle.accessor.get(ISessionActivityView).state();
        if (activity.busy || activity.pendingInteraction !== 'none') {
          return {
            entered: false,
            reason: 'owned-by-live-session',
            owner,
            ownerTitle: await this.resolveOwnerTitle(ownerHandle),
          };
        }
        await ownerHandle.accessor
          .get(IAgentLifecycleService)
          .handleOf('main')
          ?.accessor.get(IAgentTowerService)
          .exit('takeover');
      }
    }
    if (base !== undefined) await this.prepareUserBase(base);
    if (this.isActive) return { entered: true };
    await this.adoptTowerRoster();
    this.addTowerTools();
    this.lastPublished = true;
    void this.dispatcher.dispatch(
      new TowerModeEnter({ agentId: this.agentCtx.agentId, sessionId: this.sessionCtx.sessionId }),
    );
    return { entered: true };
  }

  private async prepareUserBase(base: string): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    if (await branchExists(store.repoRoot, base)) {
      if (await store.isInitialized()) {
        await store.rebase(base);
        return;
      }
      await store.init(this.sessionCtx.sessionId, base);
      return;
    }
    await this.createBaseBranch(store.repoRoot, base);
    if (await store.isInitialized()) {
      await store.rebase(base);
      return;
    }
    await store.init(this.sessionCtx.sessionId, base);
  }

  private async createBaseBranch(repoRoot: string, base: string): Promise<void> {
    const dirty = await listBaseDirtyEntries(repoRoot);
    if (dirty.some((entry) => entry.unmerged)) {
      throw new TowerProtocolError(
        'the checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before starting a tower on a new base',
      );
    }
    await checkoutNewLocalBranch(repoRoot, base);
    if (dirty.length === 0) return;
    try {
      await commitPaths(
        repoRoot,
        dirty.map((entry) => entry.path),
        `tower: snapshot of uncommitted base checkout changes (base ${base})`,
      );
    } catch (error) {
      throw new TowerProtocolError(
        `created and switched to "${base}", but committing the checkout's uncommitted changes onto it failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `The changes are still uncommitted on "${base}" — commit or move them, then re-run /tower ${base}.`,
      );
    }
  }

  async exit(reason: TowerExitReason = 'user'): Promise<void> {
    return this.serializeModeOperation(() => this.exitInternal(reason));
  }

  private async exitInternal(_reason: TowerExitReason): Promise<void> {
    if (this.agentState.get(towerKey)) {
      this.lastPublished = false;
      await this.dispatcher.dispatch(new TowerModeExit({ agentId: this.agentCtx.agentId }));
    }
    if (this.releaseTowerTools()) {
      await this.dispatcher.dispatch(
        new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: false }),
      );
    }
    await this.releaseTowerOwnership();
  }

  private addTowerTools(): void {
    const active = this.profile.getActiveToolNames();
    for (const name of TOWER_MODE_TOOLS) {
      if (active !== undefined && active.includes(name)) continue;
      if (active !== undefined) this.addedTowerTools.add(name);
      this.profile.addActiveTool(name);
    }
  }

  private releaseTowerTools(): boolean {
    if (this.addedTowerTools.size === 0) return false;
    for (const name of this.addedTowerTools) this.profile.removeActiveTool(name);
    this.addedTowerTools.clear();
    return true;
  }

  get isActive(): boolean {
    return (
      this.agentCtx.agentId === 'main' &&
      this.flags.enabled(TOWER_FLAG_ID) &&
      isTowerFeatureAssembled(this.flags) &&
      this.agentState.get(towerKey)
    );
  }

  private readonly branchLeases = new Set<string>();

  isBranchLeased(branch: string): boolean {
    return this.branchLeases.has(branch);
  }

  async withBranchLease<T>(branch: string, execute: () => Promise<T>): Promise<T> {
    if (this.branchLeases.has(branch)) {
      throw new TowerProtocolError(
        `branch "${branch}" is leased by another tower merge/rebase — not waiting; retry after that operation finishes`,
      );
    }
    this.branchLeases.add(branch);
    try {
      return await execute();
    } finally {
      this.branchLeases.delete(branch);
    }
  }

  async markAgentDied(agentId: string, status: string, reason?: string): Promise<boolean> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const entry = await store
      .markAgentDied(agentId, status, reason, this.sessionCtx.sessionId)
      .catch(() => undefined);
    return entry !== undefined;
  }

  async clearAgentDied(agentId: string): Promise<boolean> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    return store.clearAgentDied(agentId, this.sessionCtx.sessionId).catch(() => false);
  }

  private async adoptTowerRoster(): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    try {
      await store.adopt(this.sessionCtx.sessionId);
    } catch (error) {
      throw new TowerProtocolError(
        `failed to adopt the tower workspace roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async releaseTowerOwnership(): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    await store.release(this.sessionCtx.sessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async reconcileForeignTower(): Promise<void> {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) return;
    const owner = await this.resolveTowerOwner();
    if (owner === undefined || owner === this.sessionCtx.sessionId) return;
    if (this.sessions.get(owner) === undefined) {
      try {
        await this.adoptTowerRoster();
      } catch {
        await this.exit('foreign-reconcile');
      }
      return;
    }
    await this.exit('foreign-reconcile');
  }

  private async resolveOwnerTitle(ownerHandle: ISessionScopeHandle): Promise<string | undefined> {
    try {
      const meta = await ownerHandle.accessor.get(ISessionMetadata).read();
      return isUntitled(meta.title) ? undefined : meta.title;
    } catch {
      return undefined;
    }
  }

  private async resolveTowerOwner(): Promise<string | undefined> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const storeOwner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return storeOwner ?? this.agentState.get(towerOwnerKey);
  }

  private restoreTowerTools(): void {
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (!this.isActive) return;
    if (this.agentCtx.agentId !== 'main') return;
    this.addTowerTools();
    this.lastPublished = true;
    void this.dispatcher.dispatch(new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }));
  }

  private lastPublished: boolean | undefined;

  private reconcileTowerProjection(): void {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) {
      this.lastPublished = false;
      return;
    }
    const effective = this.isActive;
    if (this.lastPublished === effective) return;
    this.lastPublished = effective;
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: effective }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
