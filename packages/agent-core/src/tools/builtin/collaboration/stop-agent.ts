/**
 * StopAgentTool — cancel another agent's active run.
 *
 * Destructive fleet control: the owning `SessionSubagentHost` resolves the
 * target, checks ownership, and cancels its turn. The agent keeps its name and
 * stays addressable, so a later message resumes it. This tool only formats the
 * model-facing result.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import {
  MAX_STOP_REASON_CHARS,
  type SessionSubagentHost,
  type StopAgentResult,
} from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import STOP_AGENT_DESCRIPTION from './stop-agent.md?raw';

export const StopAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  reason: z.string().trim().max(MAX_STOP_REASON_CHARS).optional(),
});

export type StopAgentToolInput = z.infer<typeof StopAgentInputSchema>;

export class StopAgentTool implements BuiltinTool<StopAgentToolInput> {
  readonly name = 'StopAgent' as const;
  readonly description: string = STOP_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(StopAgentInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: StopAgentToolInput): ToolExecution {
    return {
      description: `Stopping agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: StopAgentToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.stopAgent(args.agent_id, args.reason, ctx.signal);
      return { output: formatStopAgentResult(result) };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function formatStopAgentResult(result: StopAgentResult): string {
  return [
    formatPlainObject({
      agent_id: result.agentId,
      name: result.label,
      status: result.stopped ? 'stopped' : 'already_idle',
      pending_turns: result.pendingTurnIds.length,
    }),
    '',
    'Send it a message to resume it; stopping does not detach its name.',
  ].join('\n');
}
