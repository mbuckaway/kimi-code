/**
 * `supermoon` domain — the `IAgentSupermoonService` contract and its DI token.
 *
 * Supermoon is a session-scoped agent mode: while active, the agent is
 * instructed (via a system reminder) to orchestrate substantive work with
 * subagents by default and to apply a battery of quality patterns. Entering is
 * triggered either manually (`manual`) or by a detected task (`task`); there is
 * no tool entry. The trigger is retained on the wire so auto-exit on
 * `turn.ended` can distinguish `task` (auto-exit) from `manual` (persists).
 * Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export type SupermoonModeTrigger = 'manual' | 'task';

export interface IAgentSupermoonService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: SupermoonModeTrigger): void;
  exit(): void;
}

export const IAgentSupermoonService = createDecorator<IAgentSupermoonService>('agentSupermoonService');
