import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { formatPlainObject } from '#/agent/task/tools/format';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  IRenameAgentTool,
  RenameAgentInputSchema,
  type RenameAgentToolInput,
} from './rename-agent';
import RENAME_AGENT_DESCRIPTION from './rename-agent.md?raw';

export class RenameAgentTool implements IRenameAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RenameAgent' as const;
  readonly description: string = RENAME_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RenameAgentInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: RenameAgentToolInput): ToolExecution {
    return {
      description: `Renaming agent ${args.agent_id} to ${args.name}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: () => this.execution(args),
    };
  }

  private async execution(args: RenameAgentToolInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagents.renameAgent(
        this.callerAgentId,
        args.agent_id,
        args.name,
      );
      return {
        output: formatPlainObject({
          agent_id: result.agentId,
          name: result.name,
          tags: result.tags.length === 0 ? undefined : result.tags.join(', '),
        }),
      };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
