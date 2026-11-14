/**
 * RenameAgentTool — rename an agent the caller owns.
 *
 * The new name goes through the same validation and session-wide reservation a
 * spawn-time name does. The agent id never changes and tags are unaffected.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import RENAME_AGENT_DESCRIPTION from './rename-agent.md?raw';

export const RenameAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
});

export type RenameAgentToolInput = z.infer<typeof RenameAgentInputSchema>;

export class RenameAgentTool implements BuiltinTool<RenameAgentToolInput> {
  readonly name = 'RenameAgent' as const;
  readonly description: string = RENAME_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RenameAgentInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

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
      const result = await this.subagentHost.renameAgent(args.agent_id, args.name);
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
