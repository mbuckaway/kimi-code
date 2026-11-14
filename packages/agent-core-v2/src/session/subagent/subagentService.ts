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
import { ILogService } from '#/_base/log/log';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  subagentParentAgentId,
  tagsOf,
} from '#/session/agentLifecycle/subagentMetadata';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
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

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private readonly reservedAgentNames = new Map<string, symbol>();

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
    return runAgentTurn(handle, request, {
      summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
      signal: opts.signal,
      onReady: opts.onReady,
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
    const resolved: OwnedAgentTarget[] = [];
    const seen = new Set<string>();
    for (const target of [...(targets.ids ?? []), ...(targets.names ?? [])]) {
      const entry = await this.resolveOwnedTarget(callerAgentId, target);
      if (seen.has(entry.agentId)) continue;
      seen.add(entry.agentId);
      resolved.push(entry);
    }
    if (targets.all === true) {
      const agents = await this.agentMetadata();
      const owned = Object.entries(agents)
        .filter(
          ([, meta]) =>
            isSubagentMeta(meta) && subagentParentAgentId(meta) === callerAgentId,
        )
        .toSorted((left, right) => left[0].localeCompare(right[0]));
      for (const [agentId, meta] of owned) {
        if (seen.has(agentId)) continue;
        seen.add(agentId);
        resolved.push({ agentId, meta });
      }
    }
    return resolved;
  }

  private async resolveOwnedTarget(
    callerAgentId: string,
    target: string,
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
    const agents = await this.agentMetadata();
    const direct = Object.hasOwn(agents, address) ? agents[address] : undefined;
    if (direct !== undefined) {
      if (direct.type === 'main') {
        throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent "${address}" is not a subagent.`, {
          details: { agentId: address },
        });
      }
      if (!isSubagentMeta(direct) || subagentParentAgentId(direct) !== callerAgentId) {
        throw new Error2(
          ErrorCodes.AGENT_NOT_OWNED,
          `Agent "${address}" is not owned by "${callerAgentId}".`,
          { details: { agentId: address } },
        );
      }
      return { agentId: address, meta: direct };
    }
    const named = Object.entries(agents)
      .filter(
        ([, meta]) =>
          isSubagentMeta(meta) &&
          subagentParentAgentId(meta) === callerAgentId &&
          agentNameOf(meta) === address,
      )
      .toSorted((left, right) => left[0].localeCompare(right[0]));
    const match = named[0];
    if (match === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${address}" does not exist.`, {
        details: { agentId: address },
      });
    }
    return { agentId: match[0], meta: match[1] };
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
    return applyProfilePromptPrefix(profile, prompt, {
      cwd: view.workDir,
      process: runtime.process!,
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

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
