/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { contextMemoryKey, popSupermoonModeReminder } from '#/agent/contextMemory/contextOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { SupermoonModeTrigger } from './supermoon';

const supermoonModeEnterSchema = z.object({
  agentId: z.string(),
  trigger: z.custom<SupermoonModeTrigger>(),
});

export class SupermoonModeEnter extends AgentEvent2<z.infer<typeof supermoonModeEnterSchema>> {
  static override readonly type = 'supermoon_mode.enter';
  static override readonly durable = true;
  static override readonly schema = supermoonModeEnterSchema;
}
export interface SupermoonModeEnter {
  readonly agentId: string;
  readonly trigger: SupermoonModeTrigger;
}

const supermoonModeExitSchema = z.object({ agentId: z.string() });

export class SupermoonModeExit extends AgentEvent2<z.infer<typeof supermoonModeExitSchema>> {
  static override readonly type = 'supermoon_mode.exit';
  static override readonly durable = true;
  static override readonly schema = supermoonModeExitSchema;
}
export interface SupermoonModeExit {
  readonly agentId: string;
}

export const supermoonKey = defineState('supermoon', (): SupermoonModeTrigger | null => null)
  .replayable({
    schema: z.custom<SupermoonModeTrigger | null>(),
  })
  .on(SupermoonModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, supermoonMode: true }));
    return e.trigger;
  })
  .on(SupermoonModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, supermoonMode: false }));
    return null;
  });

contextMemoryKey.on(SupermoonModeExit, (s) => popSupermoonModeReminder(s));
