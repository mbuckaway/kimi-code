import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMessagingService, type AgentRosterEntry } from '#/features/messaging/messaging';
import { ICrossSessionMessagingService } from '#/features/messaging/crossSession/crossSessionMessaging';
import { formatAgentRoster } from '#/features/messaging/envelope';
import { formatCrossSessionRoster } from '#/features/messaging/addressing';

import { IListAgentsTool, ListAgentsToolInputSchema, type ListAgentsToolInput } from './list-agents';
import LIST_AGENTS_DESCRIPTION from './list-agents.md?raw';

export class ListAgentsTool implements IListAgentsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ListAgents' as const;
  readonly description: string = LIST_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListAgentsToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @ICrossSessionMessagingService private readonly crossSession: ICrossSessionMessagingService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(_args: ListAgentsToolInput): ToolExecution {
    return {
      description: 'Listing agents',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    const roster: readonly AgentRosterEntry[] = await this.messaging.listAgents(
      this.callerAgentId,
    );
    const sessions = await this.crossSession.listSessions(this.sessionContext.sessionId);
    const crossSessionRoster = formatCrossSessionRoster(sessions);
    const intraSessionRoster = formatAgentRoster(roster);
    return {
      output:
        crossSessionRoster.length === 0
          ? intraSessionRoster
          : `${intraSessionRoster}\n\n${crossSessionRoster}`,
    };
  }
}
