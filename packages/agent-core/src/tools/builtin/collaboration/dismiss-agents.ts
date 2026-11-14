/**
 * DismissAgentsTool — remove owned agents from the session roster.
 *
 * Exactly one selector is accepted (`ids`, `names`, or `all: true`). The host
 * validates every target before removing anything, so a rejected call removes
 * nothing.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type {
  DismissAgentsResult,
  DismissAgentsTargets,
  SessionSubagentHost,
} from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import DISMISS_AGENTS_DESCRIPTION from './dismiss-agents.md?raw';

export const DismissAgentsInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).optional(),
    names: z.array(z.string().min(1)).min(1).optional(),
    all: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.ids !== undefined, value.names !== undefined, value.all === true].filter(Boolean)
        .length === 1,
    { message: 'Provide exactly one of ids, names, or all=true.' },
  );

export type DismissAgentsToolInput = z.infer<typeof DismissAgentsInputSchema>;

export class DismissAgentsTool implements BuiltinTool<DismissAgentsToolInput> {
  readonly name = 'DismissAgents' as const;
  readonly description: string = DISMISS_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DismissAgentsInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: DismissAgentsToolInput): ToolExecution {
    return {
      description: describeDismissTargets(args),
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, dismissRuleSubject(args)),
      execute: () => this.execution(args),
    };
  }

  private async execution(args: DismissAgentsToolInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.dismissAgents(dismissTargetsOf(args));
      return { output: formatDismissResult(result) };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function dismissTargetsOf(args: DismissAgentsToolInput): DismissAgentsTargets {
  if (args.ids !== undefined) return { ids: args.ids };
  if (args.names !== undefined) return { names: args.names };
  return { all: args.all === true };
}

function dismissRuleSubject(args: DismissAgentsToolInput): string {
  if (args.ids !== undefined) return args.ids.join(',');
  if (args.names !== undefined) return args.names.join(',');
  return 'all';
}

function describeDismissTargets(args: DismissAgentsToolInput): string {
  if (args.ids !== undefined) return `Dismissing agents: ${args.ids.join(', ')}`;
  if (args.names !== undefined) return `Dismissing agents: ${args.names.join(', ')}`;
  return 'Dismissing all owned agents';
}

function formatDismissResult(result: DismissAgentsResult): string {
  const header = `dismissed: ${String(result.dismissed.length)}`;
  const rows = result.dismissed.map((entry) =>
    formatPlainObject({
      agent_id: entry.agentId,
      name: entry.name,
      removal: entry.ghost ? 'ghost_removed' : 'removed',
    }),
  );
  return rows.length === 0 ? header : `${header}\n\n${rows.join('\n---\n')}`;
}
