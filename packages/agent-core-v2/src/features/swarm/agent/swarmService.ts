import { Service } from '#/_base/di/service';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { SwarmInjection } from './injection/swarmInjection';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { SwarmModeEnter, SwarmModeExit, swarmKey } from '../swarmOps';

export class AgentSwarmService extends Service implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(swarmKey);
    this._register(
      activateReminderWhenReady(agentLifecycle, this.agentCtx, (reminder) =>
        new SwarmInjection(
          { getTrigger: () => this.agentState.get(swarmKey) },
          reminder,
          this.context,
        ),
      ),
    );
    this._register(
      eventBus.subscribe(TurnEnded, () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.agentState.get(swarmKey) !== null) return;
    void this.dispatcher.dispatch(new SwarmModeEnter({ agentId: this.agentCtx.agentId, trigger }));
  }

  exit(): void {
    if (this.agentState.get(swarmKey) === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new SwarmModeExit({ agentId: this.agentCtx.agentId }));
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.agentState.get(swarmKey) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.agentState.get(swarmKey);
    return trigger === 'task' || trigger === 'tool';
  }
}
