/**
 * InterruptAgentTool — ask another agent to stop after its current step.
 *
 * The graceful counterpart of `StopAgent`: the target finishes the step it is
 * in — including the tools it already called — and then stops instead of being
 * cancelled mid-step.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import type {
  InterruptAgentResult,
  SessionSubagentHost,
} from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import INTERRUPT_AGENT_DESCRIPTION from './interrupt-agent.md?raw';

export const InterruptAgentInputSchema = z.object({
  agent_id: z.string().min(1),
});

export type InterruptAgentToolInput = z.infer<typeof InterruptAgentInputSchema>;

const INTERRUPT_EXPLANATION =
  'A requested interrupt lets the current step finish, including the tools it already called, and then stops the agent.';

export class InterruptAgentTool implements BuiltinTool<InterruptAgentToolInput> {
  readonly name = 'InterruptAgent' as const;
  readonly description: string = INTERRUPT_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(InterruptAgentInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: InterruptAgentToolInput): ToolExecution {
    return {
      description: `Interrupting agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: InterruptAgentToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.interruptAgent(args.agent_id, ctx.signal);
      return { output: formatInterruptAgentResult(result) };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function formatInterruptAgentResult(result: InterruptAgentResult): string {
  return [
    formatPlainObject({
      agent_id: result.agentId,
      name: result.label,
      interrupt: result.interrupted ? 'requested' : 'not_running',
    }),
    '',
    INTERRUPT_EXPLANATION,
  ].join('\n');
}
