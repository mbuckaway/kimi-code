/**
 * `supermoon` domain — `IAgentSupermoonService` implementation.
 *
 * Tracks supermoon-mode enter/exit in the `wire` `SupermoonModel` (mutated only
 * through the `supermoon_mode.enter` / `supermoon_mode.exit` Ops, read through
 * `wire.getModel`), mirrors it into `systemReminder` as live-only side effects,
 * derives `agent.status.updated` from the Ops' `toEvent`, and auto-exits on
 * turn end via `turn` when entered with the `task` trigger (`manual` persists
 * until explicitly exited). The enter-reminder removal on exit is a cross-model
 * fold on `ContextModel`: dispatching `supermoon_mode.exit` pops the reminder
 * when it is the last message, both live and on replay. The service only
 * publishes the live-only `context.spliced` event for that pop (so injector
 * bookkeeping stays in step) and appends the exit reminder when nothing was
 * popped. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import SUPERMOON_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SUPERMOON_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { IAgentSupermoonService, type SupermoonModeTrigger } from './supermoon';
import { supermoonEnter, supermoonExit, SupermoonModel } from './supermoonOps';

export class AgentSupermoonService extends Service implements IAgentSupermoonService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
  }

  enter(trigger: SupermoonModeTrigger): void {
    if (this.wire.getModel(SupermoonModel) !== null) return;
    this.wire.dispatch(supermoonEnter({ trigger }));
    this.reminders.appendSystemReminder(SUPERMOON_MODE_ENTER_REMINDER, {
      kind: 'injection',
      variant: 'supermoon_mode',
    });
  }

  exit(): void {
    const trigger = this.wire.getModel(SupermoonModel);
    if (trigger === null) return;
    const history = this.context.get();
    const last = history[history.length - 1];
    const willPop =
      last?.origin?.kind === 'injection' && last.origin.variant === 'supermoon_mode';
    this.wire.dispatch(supermoonExit({}));
    if (willPop) {
      this.eventBus.publish({
        type: 'context.spliced',
        start: history.length - 1,
        deleteCount: 1,
        messages: [],
      });
      return;
    }
    this.reminders.appendSystemReminder(SUPERMOON_MODE_EXIT_REMINDER, {
      kind: 'injection',
      variant: 'supermoon_mode_exit',
    });
  }

  get isActive(): boolean {
    return this.wire.getModel(SupermoonModel) !== null;
  }

  private get shouldAutoExit(): boolean {
    return this.wire.getModel(SupermoonModel) === 'task';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSupermoonService,
  AgentSupermoonService,
  ScopeActivation.OnScopeCreated,
  'supermoon',
);
