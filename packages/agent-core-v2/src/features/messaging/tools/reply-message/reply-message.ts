import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const ReplyMessageToolInputSchema = z.object({
  message_id: z
    .string()
    .trim()
    .min(1)
    .describe('Inbox message id from ListMessages (for example message-3).'),
  message: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: 'Message body must not be blank.',
    })
    .describe(
      'Reply body. State what you need or what you found; the receiver has no access to your context. Messages longer than 100000 characters are truncated.',
    ),
  summary: z
    .string()
    .optional()
    .describe(
      'Optional one-line preview for the activity list, truncated at 200 characters. Defaults to the first line of message.',
    ),
});

export type ReplyMessageToolInput = z.infer<typeof ReplyMessageToolInputSchema>;

export interface IReplyMessageTool extends AgentTool<ReplyMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const IReplyMessageTool = createDecorator<IReplyMessageTool>('replyMessageTool');
