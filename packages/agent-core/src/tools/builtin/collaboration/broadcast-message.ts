/**
 * BroadcastMessageTool — send one message to every addressable agent.
 *
 * Fans a message out through the owning `SessionSubagentHost`, which resolves
 * the roster and delivers sequentially; this tool only formats the
 * model-facing result.
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
  type BroadcastMessageResult,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { MAX_MESSAGE_SUMMARY_CHARS } from './send-message';
import BROADCAST_MESSAGE_DESCRIPTION from './broadcast-message.md?raw';

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

export class BroadcastMessageTool implements BuiltinTool<BroadcastMessageToolInput> {
  readonly name = 'BroadcastMessage' as const;
  readonly description: string = BROADCAST_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BroadcastMessageToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: BroadcastMessageToolInput): ToolExecution {
    return {
      description: `Broadcast message: ${messagePreview(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: BroadcastMessageToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.broadcastMessage(args.message, ctx.signal);
      const output = formatBroadcastMessageResult(result);
      return {
        output:
          args.message.length > MAX_AGENT_MESSAGE_CHARS
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

function formatBroadcastMessageResult(result: BroadcastMessageResult): string {
  if (result.delivered.length === 0 && result.failed.length === 0) {
    return 'No other agents to broadcast to.';
  }
  return [
    `Broadcast: ${String(result.delivered.length)} delivered, ${String(result.failed.length)} failed.`,
    ...result.delivered.map(
      (delivery) => `- ${delivery.label} (${delivery.agentId}): ${delivery.delivery}`,
    ),
    ...result.failed.map(
      (failure) =>
        `- ${failure.label} (${failure.agentId}): failed — ${failure.reason}: ${failure.message}`,
    ),
  ].join('\n');
}

function messagePreview(args: { readonly message: string; readonly summary?: string }): string {
  const newline = args.message.indexOf('\n');
  const source =
    args.summary ?? (newline === -1 ? args.message : args.message.slice(0, newline));
  return source.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${source.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…`
    : source;
}
