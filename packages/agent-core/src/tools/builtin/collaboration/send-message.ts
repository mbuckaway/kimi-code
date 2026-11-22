/**
 * SendMessageTool — agent-to-agent messaging.
 *
 * Collaboration tool that delivers a message to another agent through the
 * owning `SessionSubagentHost`. The host owns recipient resolution and
 * delivery, so this tool only formats the model-facing result.
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
  type SendMessageResult,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import SEND_MESSAGE_DESCRIPTION from './send-message.md?raw';

/** Longest one-line preview shown in the activity description. */
export const MAX_MESSAGE_SUMMARY_CHARS = 200;

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

export class SendMessageTool implements BuiltinTool<SendMessageToolInput> {
  readonly name = 'SendMessage' as const;
  readonly description: string = SEND_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: SendMessageToolInput): ToolExecution {
    const to = args.to.trim();
    return {
      description: `Send message to ${to}: ${messagePreview(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, to),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SendMessageToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.sendMessage(args.to, args.message, ctx.signal);
      const output = formatSendMessageResult(result);
      return {
        output: result.truncated
          ? `${output}\n\nNote: the message exceeded ${String(MAX_AGENT_MESSAGE_CHARS)} characters and was truncated before delivery.`
          : output,
      };
    } catch (error) {
      return {
        isError: true,
        output: deliveryErrorMessage(error),
      };
    }
  }
}

function deliveryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'The message could not be delivered.';
}

function messagePreview(args: SendMessageToolInput): string {
  const newline = args.message.indexOf('\n');
  const source =
    args.summary ?? (newline === -1 ? args.message : args.message.slice(0, newline));
  return source.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${source.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…`
    : source;
}

function formatSendMessageResult(result: SendMessageResult): string {
  const target = `${result.label} (${result.agentId})`;
  switch (result.delivery) {
    case 'steered':
      return `Message delivered to ${target} and started a new turn.`;
    case 'buffered':
      return `Message buffered for ${target}; it is delivered at the next step boundary.`;
    case 'resumed':
      return `Message delivered to ${target}; the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.`;
    case 'duplicate':
      return `Duplicate message: the same message was already sent to ${target}; it was not delivered again.`;
  }
}
