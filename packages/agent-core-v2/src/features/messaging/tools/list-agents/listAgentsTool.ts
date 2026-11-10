import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionMessagingService, type AgentRosterEntry } from '#/features/messaging/messaging';
import { formatAgentRoster } from '#/features/messaging/envelope';

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
    return { output: formatAgentRoster(roster) };
  }
}
