/**
 * ReplyMessageTool — reply to a message in the caller's inbox.
 *
 * Delivers a reply through the owning `SessionSubagentHost`, which resolves the
 * original sender from the inbox id; this tool only formats the model-facing
 * result.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import {
  MAX_AGENT_MESSAGE_CHARS,
  type ReplyMessageResult,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { MAX_MESSAGE_SUMMARY_CHARS } from './send-message';
import REPLY_MESSAGE_DESCRIPTION from './reply-message.md?raw';

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

export class ReplyMessageTool implements BuiltinTool<ReplyMessageToolInput> {
  readonly name = 'ReplyMessage' as const;
  readonly description: string = REPLY_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReplyMessageToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: ReplyMessageToolInput): ToolExecution {
    const messageId = args.message_id.trim();
    return {
      description: `Reply to ${messageId}: ${messagePreview(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: ReplyMessageToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.replyMessage(args.message_id, args.message, ctx.signal);
      const output = formatReplyMessageResult(result);
      return {
        output: result.truncated
          ? `${output}\n\nNote: the message exceeded ${String(MAX_AGENT_MESSAGE_CHARS)} characters and was truncated before delivery.`
          : output,
      };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function formatReplyMessageResult(result: ReplyMessageResult): string {
  const target = `${result.label} (${result.agentId})`;
  switch (result.delivery) {
    case 'steered':
      return `Reply to ${result.inReplyTo} delivered to ${target} and started a new turn.`;
    case 'buffered':
      return `Reply to ${result.inReplyTo} delivered to ${target}. It arrives at the receiver's next step boundary.`;
    case 'resumed':
      return `Reply to ${result.inReplyTo} delivered to ${target}; the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.`;
    case 'duplicate':
      return `Duplicate reply: the same message was already sent to ${target}; it was not delivered again.`;
  }
}

function messagePreview(args: { readonly message: string; readonly summary?: string }): string {
  const newline = args.message.indexOf('\n');
  const source =
    args.summary ?? (newline === -1 ? args.message : args.message.slice(0, newline));
  return source.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${source.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…`
    : source;
}
