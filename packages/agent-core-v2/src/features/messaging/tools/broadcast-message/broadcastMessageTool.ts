import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAX_AGENT_MESSAGE_CHARS } from '#/features/messaging/envelope';
import {
  ISessionMessagingService,
  type BroadcastMessageResult,
} from '#/features/messaging/messaging';

import { messagePreviewOf } from '../send-message/send-message';
import {
  BroadcastMessageToolInputSchema,
  IBroadcastMessageTool,
  type BroadcastMessageToolInput,
} from './broadcast-message';
import BROADCAST_MESSAGE_DESCRIPTION from './broadcast-message.md?raw';

export class BroadcastMessageTool implements IBroadcastMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'BroadcastMessage' as const;
  readonly description: string = BROADCAST_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BroadcastMessageToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: BroadcastMessageToolInput): ToolExecution {
    return {
      description: `Broadcast message: ${messagePreviewOf(args)}`,
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
      const result = await this.messaging.broadcastMessage(
        this.callerAgentId,
        args.message,
        ctx.signal,
      );
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
