import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { AgentReminder, type ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';
import SUPERMOON_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SUPERMOON_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { IAgentSupermoonService, type SupermoonModeTrigger } from './supermoon';
import { SupermoonModeEnter, SupermoonModeExit, supermoonKey } from './supermoonOps';

export class AgentSupermoonService extends Service implements IAgentSupermoonService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(supermoonKey);
    this._register(
      eventBus.subscribe(TurnEnded, () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
  }

  enter(trigger: SupermoonModeTrigger): void {
    if (this.agentState.get(supermoonKey) !== null) return;
    void this.dispatcher.dispatch(
      new SupermoonModeEnter({ agentId: this.agentCtx.agentId, trigger }),
    );
    this.reminder().notify(SUPERMOON_MODE_ENTER_REMINDER, { variant: 'supermoon_mode' });
  }

  exit(): void {
    if (this.agentState.get(supermoonKey) === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new SupermoonModeExit({ agentId: this.agentCtx.agentId }));
    const popped = this.context.publishTrailingRemoval(history);
    if (popped) return;
    this.reminder().notify(SUPERMOON_MODE_EXIT_REMINDER, { variant: 'supermoon_mode_exit' });
  }

  get isActive(): boolean {
    return this.agentState.get(supermoonKey) !== null;
  }

  private get shouldAutoExit(): boolean {
    return this.agentState.get(supermoonKey) === 'task';
  }

  private reminder(): ReminderRuntime {
    return this.agentLifecycle.resolve(this.agentCtx.agentContext, AgentReminder);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSupermoonService,
  AgentSupermoonService,
  ScopeActivation.OnScopeCreated,
  'supermoon',
);
