import type { Agent } from '..';

import SUPERMOON_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SUPERMOON_MODE_EXIT_REMINDER from './exit-reminder.md?raw';

/**
 * manual = persistent toggle (settings / agent_config);
 * task = one-shot supermoon prompt (auto-exits when the turn ends);
 * tool = EnterSupermoonMode tool entry.
 */
export type SupermoonModeTrigger = 'manual' | 'task' | 'tool';

/**
 * v1 supermoon-mode engine, mirroring `SwarmMode`'s journal/restore/reminder
 * plumbing but with v2 supermoon semantics (deliberately NOT swarm's):
 * the enter reminder is appended for EVERY trigger including 'tool', and
 * only the 'task' trigger auto-exits at turn end — 'manual' and 'tool'
 * persist until explicitly exited.
 */
export class SupermoonMode {
  protected active: SupermoonModeTrigger | null = null;

  constructor(protected readonly agent: Agent) {}

  enter(trigger: SupermoonModeTrigger): void {
    if (this.active !== null) return;
    this.agent.records.logRecord({ type: 'supermoon_mode.enter', trigger });
    this.active = trigger;
    this.agent.context.appendSystemReminder(SUPERMOON_MODE_ENTER_REMINDER, {
      kind: 'injection',
      variant: 'supermoon_mode',
    });
    this.agent.emitStatusUpdated();
  }

  restoreEnter(trigger: SupermoonModeTrigger): void {
    this.active = trigger;
  }

  exit(): void {
    if (this.active === null) return;
    this.agent.records.logRecord({ type: 'supermoon_mode.exit' });
    this.active = null;
    this.agent.emitStatusUpdated();
    if (
      this.agent.context.popMatchedMessage(
        (origin) => origin?.kind === 'injection' && origin.variant === 'supermoon_mode',
      )
    ) {
      return;
    }
    if (!this.agent.records.restoring) {
      this.agent.context.appendSystemReminder(SUPERMOON_MODE_EXIT_REMINDER, {
        kind: 'injection',
        variant: 'supermoon_mode_exit',
      });
    }
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get shouldAutoExit(): boolean {
    return this.active === 'task';
  }
}
