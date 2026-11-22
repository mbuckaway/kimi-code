import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MAX_AGENT_MESSAGE_CHARS } from '#/features/messaging/envelope';
import {
  ISessionMessagingService,
  type ReplyMessageResult,
} from '#/features/messaging/messaging';
import { ICrossSessionMessagingService } from '#/features/messaging/crossSession/crossSessionMessaging';
import { MAX_INBOX_MESSAGES } from '#/features/messaging/sessionInbox';
import {
  createCrossSessionMessageId,
  formatCrossSessionSendResult,
} from '#/features/messaging/addressing';

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
    @ICrossSessionMessagingService private readonly crossSession: ICrossSessionMessagingService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
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
      const crossSessionReply = await this.replyToSession(args, ctx);
      if (crossSessionReply !== undefined) return crossSessionReply;
      const result = await this.messaging.replyMessage(
        this.callerAgentId,
        args.message_id,
        args.message,
        ctx.signal,
      );
      return this.outputOf(formatReplyMessageResult(result), result.truncated);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async replyToSession(
    args: ReplyMessageToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult | undefined> {
    const inbox = await this.messaging.listMessages(this.callerAgentId, {
      limit: MAX_INBOX_MESSAGES,
    });
    const original = inbox.messages.find((entry) => entry.id === args.message_id.trim());
    if (original === undefined || original.fromSessionId === undefined) return undefined;
    const fromSessionId = original.fromSessionId;
    const result = await this.crossSession.send(this.sessionContext.sessionId, fromSessionId, {
      messageId: createCrossSessionMessageId(),
      message: args.message,
      fromSessionTitle: (await this.sessionMetadata.read()).title,
      inReplyTo: original.id,
      signal: ctx.signal,
    });
    const formatted = formatCrossSessionSendResult({
      kind: 'reply',
      inReplyTo: original.id,
      target: { sessionId: fromSessionId, title: original.fromSessionLabel },
      result,
    });
    return this.outputOf(formatted.output, formatted.truncated, formatted.isError);
  }

  private outputOf(
    output: string,
    truncated: boolean,
    isError = false,
  ): ExecutableToolResult {
    if (isError) return { isError: true, output };
    return {
      output: truncated
        ? `${output}\n\nNote: the message exceeded ${String(MAX_AGENT_MESSAGE_CHARS)} characters and was truncated before delivery.`
        : output,
    };
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
