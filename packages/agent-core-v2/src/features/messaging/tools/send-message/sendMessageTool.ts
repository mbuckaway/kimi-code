import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MAX_AGENT_MESSAGE_CHARS } from '#/features/messaging/envelope';
import { ISessionMessagingService, type SendMessageResult } from '#/features/messaging/messaging';
import {
  ICrossSessionMessagingService,
  type CrossSessionSessionEntry,
} from '#/features/messaging/crossSession/crossSessionMessaging';
import {
  classifyMessageAddress,
  createCrossSessionMessageId,
  formatAmbiguousCrossSessionMessage,
  formatCrossSessionSendResult,
  formatUnknownCrossSessionMessage,
  resolveCrossSessionTarget,
} from '#/features/messaging/addressing';

import {
  ISendMessageTool,
  SendMessageToolInputSchema,
  messagePreviewOf,
  type SendMessageToolInput,
} from './send-message';
import SEND_MESSAGE_DESCRIPTION from './send-message.md?raw';

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendMessage' as const;
  readonly description: string = SEND_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageToolInputSchema);

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

  resolveExecution(args: SendMessageToolInput): ToolExecution {
    const to = args.to.trim();
    return {
      description: `Send message to ${to}: ${messagePreviewOf(args)}`,
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
      const address = classifyMessageAddress(args.to);
      if (address.kind === 'crossSession') {
        return await this.sendCrossSession(args, address.target, ctx);
      }
      const result = await this.messaging.sendMessage(
        this.callerAgentId,
        args.to,
        args.message,
        ctx.signal,
      );
      return this.outputOf(formatSendMessageResult(result), result.truncated);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async sendCrossSession(
    args: SendMessageToolInput,
    target: string,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const callerSessionId = this.sessionContext.sessionId;
    const resolution = await resolveCrossSessionTarget(
      this.crossSession,
      callerSessionId,
      target,
    );
    switch (resolution.kind) {
      case 'unknown':
        throw new Error2(
          ErrorCodes.MESSAGE_RECIPIENT_UNKNOWN,
          formatUnknownCrossSessionMessage(target, resolution.sessions),
        );
      case 'ambiguous':
        throw new Error2(
          ErrorCodes.MESSAGE_RECIPIENT_AMBIGUOUS,
          formatAmbiguousCrossSessionMessage(target, resolution.matches),
        );
      case 'resolved':
        return this.deliverToSession(args, resolution.session, callerSessionId, ctx);
    }
  }

  private async deliverToSession(
    args: SendMessageToolInput,
    target: CrossSessionSessionEntry,
    callerSessionId: string,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const result = await this.crossSession.send(callerSessionId, target.sessionId, {
      messageId: createCrossSessionMessageId(),
      message: args.message,
      fromSessionTitle: (await this.sessionMetadata.read()).title,
      signal: ctx.signal,
    });
    const formatted = formatCrossSessionSendResult({
      kind: 'message',
      target,
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

function formatSendMessageResult(result: SendMessageResult): string {
  const target = `${result.label} (${result.agentId})`;
  switch (result.delivery) {
    case 'steered':
      return `Message delivered to ${target}. It arrives at the receiver's next step boundary.`;
    case 'newTurn':
      return `Message delivered to ${target} and started a new turn.`;
    case 'resumed':
      return `Message delivered to ${target}; the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.`;
    case 'duplicate':
      return `Duplicate message: the same message was already sent to ${target}; it was not delivered again.`;
  }
}
