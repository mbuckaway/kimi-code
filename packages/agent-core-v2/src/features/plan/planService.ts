import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { generateHeroSlug } from '#/_base/utils/hero-slug';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { PlanModeInjection } from '#/features/plan/injection/planModeInjection';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IConfigService } from '#/app/config/config';
import { describeUnknownError } from '#/app/config/configPure';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { DEFAULT_MODEL_SECTION, PLANNING_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ContextUndone } from '#/agent/undo/undoService';
import type { ToolFileAccess } from '#/tool/toolContract';
import { canSwitchModel } from '#/features/model/switchGuard';
import {
  IAgentPlanService,
  type PlanData,
  type PlanFilePath,
} from './plan';
import { ExitPlanModeReview } from './exitPlanModeReview';
import {
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  planKey,
  PlanRevision,
} from './planOps';

export class AgentPlanService extends Service implements IAgentPlanService {
  declare readonly _serviceBrand: undefined;

  private readonly review: ExitPlanModeReview;
  private modelAtPlanEnter: string | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IEventBus eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ITelemetryService telemetry: ITelemetryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IConfigService private readonly configService: IConfigService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.agentState.contributeState(planKey);

    this.review = new ExitPlanModeReview(this, this.toolApproval, telemetry);

    this._register(
      this.dispatcher.hooks.onDidRestore.register('plan', async (_ctx, next) => {
        this.restoreTelemetryMode();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe(ContextUndone, () => {
        this.restoreTelemetryMode();
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, planMode: this.isActive }),
        );
      }),
    );

    this._register(new PlanModeInjection(injector, this, this.context, agentState));
    this._register(this.registerPlanGuard(toolExecutor));
  }

  private registerPlanGuard(toolExecutor: IAgentToolExecutorService): IDisposable {
    return toolExecutor.onBeforeExecuteTool((event) => this.guardToolExecution(event));
  }

  private async guardToolExecution(event: BeforeToolExecuteEvent): Promise<void> {
    const toolName = event.toolCall.name;
    const plan = await this.status();

    if (toolName === 'ExitPlanMode') {
      if (plan !== null && this.modeService.mode !== 'auto') {
        event.waitUntil(() => this.review.requestApproval(event));
      }
      return;
    }

    if (plan === null) {
      return;
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      if (writesOnlyPlanFile(event, plan.path)) {
        event.allow();
        return;
      }
      event.veto(
        denyToolExecution(this.toolApproval.formatDenyMessage(planModeWriteDeniedMessage(plan.path))),
      );
      return;
    }

    if (toolName === 'TaskStop') {
      event.veto(
        denyToolExecution(
          this.toolApproval.formatDenyMessage(
            'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
          ),
        ),
      );
      return;
    }

    if (toolName === 'CronCreate' || toolName === 'CronDelete') {
      event.veto(
        denyToolExecution(
          this.toolApproval.formatDenyMessage(
            `${toolName} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
          ),
        ),
      );
      return;
    }
  }

  private get isActive(): boolean {
    return this.agentState.get(planKey).active;
  }

  private currentPlanFilePath(): PlanFilePath {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return null;
    return this.planFilePathFor(state.id);
  }

  private restoreTelemetryMode(): void {
    this.telemetryContext.set({ mode: this.isActive ? 'plan' : 'agent' });
  }

  private createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(id = this.createPlanId(), createFile = false): Promise<void> {
    if (this.isActive) {
      throw new Error2(ErrorCodes.SESSION_PLAN_MODE_INVALID, 'Already in plan mode');
    }

    const planFilePath = this.planFilePathFor(id);
    let enterRecorded = false;
    try {
      await this.ensurePlanDirectory(planFilePath);
      await this.dispatcher.dispatch(new PlanModeEnter({ agentId: this.agentCtx.agentId, id }));
      this.telemetryContext.set({ mode: 'plan' });
      enterRecorded = true;
      await this.maybeSwitchToPlanningModel();
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        await this.cancel(id);
      }
      throw error;
    }
  }

  async cancel(id?: string): Promise<void> {
    void this.dispatcher.dispatch(new PlanModeCancel({ agentId: this.agentCtx.agentId, id }));
    this.telemetryContext.set({ mode: 'agent' });
    await this.restoreModelAfterPlan();
  }

  async clear(): Promise<void> {
    const path = this.currentPlanFilePath();
    if (path === null) return;
    await this.writeEmptyPlanFile(path);
  }

  async exit(id?: string): Promise<void> {
    void this.dispatcher.dispatch(new PlanModeExit({ agentId: this.agentCtx.agentId, id }));
    this.telemetryContext.set({ mode: 'agent' });
    await this.restoreModelAfterPlan();
  }

  async recordRevision(): Promise<void> {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return;
    const id = state.id;
    const content = await this.hostFs.readText(this.planFilePathFor(id));
    const bytes = Buffer.from(content, 'utf8');
    const version = (state.revisionCount?.[id] ?? 0) + 1;
    const scope = this.agentCtx.scope();
    const key = `plan/${id}/v${version}.md`;
    await this.blobs.put(scope, key, bytes);
    await this.dispatcher.dispatch(
      new PlanRevision({
        agentId: this.agentCtx.agentId,
        id,
        version,
        path: `${scope}/${key}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      }),
    );
  }

  async status(): Promise<PlanData> {
    const state = this.agentState.get(planKey);
    if (!state.active || state.id === undefined) return null;
    const path = this.planFilePathFor(state.id);
    let content = '';
    try {
      content = await this.hostFs.readText(path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: state.id,
      content,
      path,
    };
  }

  private planFilePathFor(id: string): string {
    return join(this.sessionCtx.sessionDir, 'agents', this.agentCtx.agentId, 'plans', `${id}.md`);
  }

  private async maybeSwitchToPlanningModel(): Promise<void> {
    const planningModel = this.configService.get<string>(PLANNING_MODEL_SECTION);
    const modelAtEnter = this.profile.data().modelAlias;
    if (planningModel === undefined || planningModel === modelAtEnter) return;
    const currentId = this.profile.getModel();
    if (currentId.length === 0) {
      this.log.warn(
        'plan mode: planning model is configured but no current model is bound; leaving the model unchanged',
        { planningModel },
      );
      return;
    }
    try {
      const target = this.modelCatalog.get(planningModel);
      const current = this.modelCatalog.get(currentId);
      if (!canSwitchModel(target.maxContextSize, current.maxContextSize)) {
        this.log.warn(
          'plan mode: planning model has a smaller context window than the current model; leaving the model unchanged',
          { planningModel, currentModel: currentId },
        );
        return;
      }
      await this.profile.setModel(planningModel);
      this.modelAtPlanEnter = modelAtEnter ?? currentId;
      this.log.info('plan mode: switched to the configured planning model', { planningModel });
    } catch (error) {
      this.log.warn(
        'plan mode: failed to switch to the planning model; leaving the model unchanged',
        { planningModel, error: describeUnknownError(error) },
      );
    }
  }

  private async restoreModelAfterPlan(): Promise<void> {
    const restoreTarget = this.configService.get<string>(DEFAULT_MODEL_SECTION) ?? this.modelAtPlanEnter;
    if (restoreTarget === undefined) return;
    const currentId = this.profile.getModel();
    if (currentId.length === 0 || currentId === restoreTarget) return;
    try {
      const target = this.modelCatalog.get(restoreTarget);
      const current = this.modelCatalog.get(currentId);
      if (!canSwitchModel(target.maxContextSize, current.maxContextSize)) {
        this.log.warn(
          'plan mode: cannot restore the model because it has a smaller context window; leaving the current model',
          { restoreTarget, currentModel: currentId },
        );
        return;
      }
      await this.profile.setModel(restoreTarget);
      this.log.info('plan mode: restored the model after plan mode', { model: restoreTarget });
    } catch (error) {
      this.log.warn(
        'plan mode: failed to restore the model after plan mode',
        { restoreTarget, error: describeUnknownError(error) },
      );
    }
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.hostFs.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.hostFs.mkdir(dirname(path), { recursive: true });
  }
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function writesOnlyPlanFile(
  context: ResolvedToolExecutionHookContext,
  planFilePath: string,
): boolean {
  const writeAccesses = (context.execution.accesses ?? []).filter(
    (access): access is ToolFileAccess =>
      access.kind === 'file' &&
      (access.operation === 'write' || access.operation === 'readwrite'),
  );
  if (writeAccesses.length === 0) return false;
  return writeAccesses.every((access) => access.path === planFilePath);
}

export function planModeWriteDeniedMessage(planFilePath: string | null): string {
  return (
    `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}

export { AgentPlanService as Plan };
