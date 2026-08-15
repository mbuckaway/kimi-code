/**
 * `supermoon` domain — the `IAgentSupermoonService` contract and its DI token.
 *
 * Supermoon is a session-scoped agent mode: while active, the agent is
 * instructed (via a system reminder) to orchestrate substantive work with
 * subagents by default and to apply a battery of quality patterns. Entering is
 * triggered either manually (`manual`), by a detected task (`task`), or through
 * the EnterSupermoonMode tool (`tool`). The trigger is retained on the wire so
 * auto-exit on `turn.ended` can distinguish `task` (auto-exit) from `manual`
 * and `tool` (persist until explicitly exited). Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export type SupermoonModeTrigger = 'manual' | 'task' | 'tool';

export interface IAgentSupermoonService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: SupermoonModeTrigger): void;
  exit(): void;
}

export const IAgentSupermoonService = createDecorator<IAgentSupermoonService>('agentSupermoonService');
