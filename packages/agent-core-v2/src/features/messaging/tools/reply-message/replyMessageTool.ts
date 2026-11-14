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
  type ReplyMessageResult,
} from '#/features/messaging/messaging';

import { messagePreviewOf } from '../send-message/send-message';
import {
  IReplyMessageTool,
  ReplyMessageToolInputSchema,
  type ReplyMessageToolInput,
} from './reply-message';
import REPLY_MESSAGE_DESCRIPTION from './reply-message.md?raw';

export class ReplyMessageTool implements IReplyMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ReplyMessage' as const;
  readonly description: string = REPLY_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReplyMessageToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: ReplyMessageToolInput): ToolExecution {
    const messageId = args.message_id.trim();
    return {
      description: `Reply to ${messageId}: ${messagePreviewOf(args)}`,
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
      const result = await this.messaging.replyMessage(
        this.callerAgentId,
        args.message_id,
        args.message,
        ctx.signal,
      );
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
      return `Reply to ${result.inReplyTo} delivered to ${target}. It arrives at the receiver's next step boundary.`;
    case 'newTurn':
      return `Reply to ${result.inReplyTo} delivered to ${target} and started a new turn.`;
    case 'resumed':
      return `Reply to ${result.inReplyTo} delivered to ${target}; the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.`;
    case 'duplicate':
      return `Duplicate reply: the same message was already sent to ${target}; it was not delivered again.`;
  }
}
