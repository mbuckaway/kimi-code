/**
 * AgentHealthTool — inspect one agent's derived health and background capacity.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { BackgroundManager } from '../../../agent/background';
import {
  agentTaskFor,
  formatBackgroundCapacity,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import { formatPlainObject } from '../../background/format';
import AGENT_HEALTH_DESCRIPTION from './agent-health.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const AgentHealthInputSchema = z.object({
  agent_id: z.string().min(1).describe('The agent id to inspect (from ListAgents).'),
});

export type AgentHealthInput = z.infer<typeof AgentHealthInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class AgentHealthTool implements BuiltinTool<AgentHealthInput> {
  readonly name = 'AgentHealth' as const;
  readonly description: string = AGENT_HEALTH_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentHealthInputSchema);

  constructor(
    private readonly manager: BackgroundManager,
    private readonly subagentHost: SessionSubagentHost,
  ) {}

  resolveExecution(args: AgentHealthInput): ToolExecution {
    return {
      description: `Inspecting health of agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AgentHealthInput): Promise<ExecutableToolResult> {
    const entry = this.subagentHost
      .listAgents()
      .find((candidate) => candidate.agentId === args.agent_id);
    if (entry === undefined) {
      return { isError: true, output: `Agent not found: ${args.agent_id}` };
    }

    const task = agentTaskFor(this.manager.list(false), args.agent_id);

    return {
      output: formatPlainObject({
        agentId: args.agent_id,
        state: entry.state,
        loopState: entry.running ? 'running' : 'idle',
        taskId: task?.taskId,
        taskStatus: task?.status,
        taskKind: task?.kind,
        taskStartedAt: task?.startedAt,
        taskEndedAt: task?.endedAt,
        backgroundCapacity: formatBackgroundCapacity(this.manager.capacity()),
      }),
      isError: false,
    };
  }
}
