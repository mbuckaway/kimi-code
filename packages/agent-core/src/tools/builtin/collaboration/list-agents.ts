/**
 * ListAgentsTool — list the agents the caller can message.
 *
 * Reads the owning `SessionSubagentHost` roster and renders it as plain text:
 * the root agent plus the live children, with ids and running state.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { AgentRosterEntry, SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import LIST_AGENTS_DESCRIPTION from './list-agents.md?raw';

export const ListAgentsToolInputSchema = z.object({}).strict();

export type ListAgentsToolInput = z.infer<typeof ListAgentsToolInputSchema>;

export class ListAgentsTool implements BuiltinTool<ListAgentsToolInput> {
  readonly name = 'ListAgents' as const;
  readonly description: string = LIST_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListAgentsToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(_args: ListAgentsToolInput): ToolExecution {
    return {
      description: 'Listing agents',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => this.execution(),
    };
  }

  private execution(): ExecutableToolResult {
    return { output: formatAgentRoster(this.subagentHost.listAgents()) };
  }
}

function formatAgentRoster(roster: readonly AgentRosterEntry[]): string {
  const lines = ['Agents you can message:'];
  for (const entry of roster) {
    const state = entry.running ? 'running' : 'idle';
    lines.push(`- ${entry.name ?? entry.agentId} (id: ${entry.agentId}) — ${state}`);
  }
  return lines.join('\n');
}
