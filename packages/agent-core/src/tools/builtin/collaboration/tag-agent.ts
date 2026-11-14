/**
 * TagAgentTool — replace the tags on an agent the caller owns.
 *
 * Tags are labels only: setting them never interrupts, stops, or renames the
 * agent. `tags: []` clears them.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import TAG_AGENT_DESCRIPTION from './tag-agent.md?raw';

export const MAX_AGENT_TAG_CHARS = 32;
export const MAX_AGENT_TAGS = 20;

export const TagAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(MAX_AGENT_TAG_CHARS)
        .refine((tag) => !tag.includes(','), {
          message: 'A tag must not contain a comma.',
        }),
    )
    .max(MAX_AGENT_TAGS),
});

export type TagAgentToolInput = z.infer<typeof TagAgentInputSchema>;

export class TagAgentTool implements BuiltinTool<TagAgentToolInput> {
  readonly name = 'TagAgent' as const;
  readonly description: string = TAG_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TagAgentInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

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
      const result = await this.subagentHost.setAgentTags(args.agent_id, args.tags);
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
