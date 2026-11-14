import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  ISessionMessagingService,
  type AgentInbox,
  type AgentInboxMessage,
} from '#/features/messaging/messaging';

import { previewOf } from '../send-message/send-message';
import {
  IListMessagesTool,
  ListMessagesToolInputSchema,
  type ListMessagesToolInput,
} from './list-messages';
import LIST_MESSAGES_DESCRIPTION from './list-messages.md?raw';

export class ListMessagesTool implements IListMessagesTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ListMessages' as const;
  readonly description: string = LIST_MESSAGES_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListMessagesToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

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
      const inbox = await this.messaging.listMessages(this.callerAgentId, {
        from: args.from,
        limit: args.limit,
      });
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
