/**
 * ListMessagesTool — list the caller's inbox messages.
 *
 * Reads the owning `SessionSubagentHost` inbox and renders it as plain text:
 * newest first, with the message ids `ReplyMessage` needs.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  MAX_INBOX_MESSAGES,
  type AgentInbox,
  type AgentInboxMessage,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { MAX_MESSAGE_SUMMARY_CHARS } from './send-message';
import LIST_MESSAGES_DESCRIPTION from './list-messages.md?raw';

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

export class ListMessagesTool implements BuiltinTool<ListMessagesToolInput> {
  readonly name = 'ListMessages' as const;
  readonly description: string = LIST_MESSAGES_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListMessagesToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: ListMessagesToolInput): ToolExecution {
    return {
      description: 'Listing inbox messages',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => this.execution(args),
    };
  }

  private async execution(args: ListMessagesToolInput): Promise<ExecutableToolResult> {
    try {
      const inbox = this.subagentHost.listMessages({ from: args.from, limit: args.limit });
      return { output: formatInbox(inbox) };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function formatInbox(inbox: AgentInbox): string {
  const pending = `${String(inbox.pending)} queued, not yet delivered.`;
  if (inbox.messages.length === 0) return `Inbox is empty. ${pending}`;
  return [
    `Inbox: ${String(inbox.messages.length)} message(s), newest first. ${pending}`,
    ...inbox.messages.map(formatInboxMessage),
  ].join('\n');
}

function formatInboxMessage(message: AgentInboxMessage): string {
  const label = message.fromLabel ?? message.from;
  const truncated = message.truncated ? ' [truncated]' : '';
  return `- ${message.id} · from ${label} (${message.from}) · ${message.delivery} · ${previewOf(message.message)}${truncated}`;
}

function previewOf(text: string): string {
  const newline = text.indexOf('\n');
  const source = newline === -1 ? text : text.slice(0, newline);
  return source.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${source.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…`
    : source;
}
