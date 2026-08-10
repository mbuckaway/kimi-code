/**
 * `supermoon` domain — wire Model (`SupermoonModel`) and the
 * `supermoon_mode.enter` / `supermoon_mode.exit` Ops (`supermoonEnter` /
 * `supermoonExit`) for the agent's supermoon mode.
 *
 * Declares supermoon mode as a `SupermoonModeTrigger | null` wire Model (the
 * trigger is retained, not collapsed to a boolean, so `shouldAutoExit` can
 * still distinguish `task` / `manual`) plus the two Ops that set and clear it.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { SupermoonModeTrigger } from './supermoon';

export const SupermoonModel = defineModel<SupermoonModeTrigger | null>('supermoon', () => null);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'supermoon_mode.enter': typeof supermoonEnter;
    'supermoon_mode.exit': typeof supermoonExit;
  }
}

export const supermoonEnter = SupermoonModel.defineOp('supermoon_mode.enter', {
  schema: z.object({ trigger: z.custom<SupermoonModeTrigger>() }),
  apply: (_s, p) => p.trigger,
  toEvent: () => ({ type: 'agent.status.updated' as const, supermoonMode: true }),
});

export const supermoonExit = SupermoonModel.defineOp('supermoon_mode.exit', {
  schema: z.object({}),
  apply: () => null,
  toEvent: () => ({ type: 'agent.status.updated' as const, supermoonMode: false }),
});
