import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionMessagingService, type SendMessageResult } from '#/features/messaging/messaging';
import { MAX_AGENT_MESSAGE_CHARS } from '#/features/messaging/envelope';

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
      const result = await this.messaging.sendMessage(
        this.callerAgentId,
        args.to,
        args.message,
        ctx.signal,
      );
      const output = formatSendMessageResult(result);
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
