import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_MESSAGE_SUMMARY_CHARS = 200;

export function previewOf(text: string): string {
  const newline = text.indexOf('\n');
  return truncatePreview(newline === -1 ? text : text.slice(0, newline));
}

export function messagePreviewOf(args: {
  readonly message: string;
  readonly summary?: string;
}): string {
  return args.summary === undefined ? previewOf(args.message) : truncatePreview(args.summary);
}

function truncatePreview(source: string): string {
  return source.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${source.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…`
    : source;
}

export const SendMessageToolInputSchema = z.object({
  to: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Recipient: "main" for the root agent, an agent name, or a raw agent id (see ListAgents).',
    ),
  message: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: 'Message body must not be blank.',
    })
    .describe(
      'Message body. State what you need or what you found; the receiver has no access to your context. Messages longer than 100000 characters are truncated.',
    ),
  summary: z
    .string()
    .optional()
    .describe(
      'Optional one-line preview for the activity list, truncated at 200 characters. Defaults to the first line of message.',
    ),
});

export type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export interface ISendMessageTool extends AgentTool<SendMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');
