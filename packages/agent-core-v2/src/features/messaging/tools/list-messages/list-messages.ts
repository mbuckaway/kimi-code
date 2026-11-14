import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { MAX_INBOX_MESSAGES } from '#/features/messaging/sessionInbox';
import { type AgentTool } from '#/tool/toolContract';

export const ListMessagesToolInputSchema = z.object({
  from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Only messages from this agent (an id or name from ListAgents).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_INBOX_MESSAGES)
    .optional()
    .describe('Maximum messages to return, newest first.'),
});

export type ListMessagesToolInput = z.infer<typeof ListMessagesToolInputSchema>;

export interface IListMessagesTool extends AgentTool<ListMessagesToolInput> {
  readonly _serviceBrand: undefined;
}

export const IListMessagesTool = createDecorator<IListMessagesTool>('listMessagesTool');
