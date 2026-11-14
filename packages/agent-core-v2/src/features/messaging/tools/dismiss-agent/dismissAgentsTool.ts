import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { formatPlainObject } from '#/agent/task/tools/format';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_FLEET_CONTROL_FLAG_ID } from '#/features/messaging/flag';
import {
  ISessionSubagentService,
  type DismissAgentsResult,
  type DismissAgentsTargets,
} from '#/session/subagent/subagent';

import {
  DismissAgentsInputSchema,
  IDismissAgentsTool,
  type DismissAgentsToolInput,
} from './dismiss-agent';
import DISMISS_AGENTS_DESCRIPTION from './dismiss-agent.md?raw';

export class DismissAgentsTool implements IDismissAgentsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'DismissAgents' as const;
  readonly description: string = DISMISS_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DismissAgentsInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IFlagService private readonly flags: IFlagService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: DismissAgentsToolInput): ToolExecution {
    return {
      description: describeTargets(args),
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, ruleSubject(args)),
      execute: () => this.execution(args),
    };
  }

  private async execution(args: DismissAgentsToolInput): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(AGENT_FLEET_CONTROL_FLAG_ID)) {
      return {
        isError: true,
        output: 'DismissAgents is disabled: the agent_fleet_control experimental flag is off.',
      };
    }
    try {
      const result = await this.subagents.dismissAgents(this.callerAgentId, targetsOf(args));
      return { output: formatDismissResult(result) };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function targetsOf(args: DismissAgentsToolInput): DismissAgentsTargets {
  if (args.ids !== undefined) return { ids: args.ids };
  if (args.names !== undefined) return { names: args.names };
  return { all: args.all === true };
}

function ruleSubject(args: DismissAgentsToolInput): string {
  if (args.ids !== undefined) return args.ids.join(',');
  if (args.names !== undefined) return args.names.join(',');
  return 'all';
}

function describeTargets(args: DismissAgentsToolInput): string {
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
