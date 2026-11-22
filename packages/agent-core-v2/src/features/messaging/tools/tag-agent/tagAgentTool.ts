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

import { ITagAgentTool, TagAgentInputSchema, type TagAgentToolInput } from './tag-agent';
import TAG_AGENT_DESCRIPTION from './tag-agent.md?raw';

export class TagAgentTool implements ITagAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TagAgent' as const;
  readonly description: string = TAG_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TagAgentInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: TagAgentToolInput): ToolExecution {
    return {
      description: `Tagging agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TagAgentToolInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagents.setAgentTags(
        this.callerAgentId,
        args.agent_id,
        args.tags,
      );
      return {
        output: formatPlainObject({
          agent_id: result.agentId,
          name: result.name,
          tags: result.tags.length === 0 ? '(none)' : result.tags.join(', '),
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
