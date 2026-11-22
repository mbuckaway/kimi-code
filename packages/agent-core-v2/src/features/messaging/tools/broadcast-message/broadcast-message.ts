import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const BroadcastMessageToolInputSchema = z.object({
  message: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: 'Message body must not be blank.',
    })
    .describe(
      'Broadcast body. State what you need or what you found; receivers have no access to your context. Messages longer than 100000 characters are truncated.',
    ),
  summary: z
    .string()
    .optional()
    .describe(
      'Optional one-line preview for the activity list, truncated at 200 characters. Defaults to the first line of message.',
    ),
});

export type BroadcastMessageToolInput = z.infer<typeof BroadcastMessageToolInputSchema>;

export interface IBroadcastMessageTool extends AgentTool<BroadcastMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const IBroadcastMessageTool =
  createDecorator<IBroadcastMessageTool>('broadcastMessageTool');
