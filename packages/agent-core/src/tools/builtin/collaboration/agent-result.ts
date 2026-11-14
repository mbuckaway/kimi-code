/**
 * AgentResultTool — read the latest result of a subagent by its agent id.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import {
  type BackgroundManager,
  type BackgroundTaskStatus,
  isBackgroundTaskTerminal,
} from '../../../agent/background';
import { agentTaskFor } from '../../../session/subagent-host';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import { formatPlainObject } from '../../background/format';
import AGENT_RESULT_DESCRIPTION from './agent-result.md?raw';

/** Maximum bytes of output included inline as a preview. */
const OUTPUT_PREVIEW_BYTES = 32 * 1024; // 32 KiB

// ── Input schema ─────────────────────────────────────────────────────

export const AgentResultInputSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .describe('The agent id whose result to read (from ListAgents or TaskList).'),
});

export type AgentResultInput = z.infer<typeof AgentResultInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

function retrievalStatus(status: BackgroundTaskStatus): 'success' | 'not_ready' {
  return isBackgroundTaskTerminal(status) ? 'success' : 'not_ready';
}

export class AgentResultTool implements BuiltinTool<AgentResultInput> {
  readonly name = 'AgentResult' as const;
  readonly description: string = AGENT_RESULT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentResultInputSchema);

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: AgentResultInput): ToolExecution {
    return {
      description: `Reading result of agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AgentResultInput): Promise<ExecutableToolResult> {
    const task = agentTaskFor(this.manager.list(false), args.agent_id);
    if (task === undefined) {
      return { isError: true, output: `No task found for agent: ${args.agent_id}` };
    }

    const output = await this.manager.getOutputSnapshot(task.taskId, OUTPUT_PREVIEW_BYTES);
    const lines = [
      formatPlainObject({
        retrievalStatus: retrievalStatus(task.status),
        agentId: args.agent_id,
        ...task,
        outputPath: output.outputPath,
        outputSizeBytes: output.outputSizeBytes,
        outputPreviewBytes: output.previewBytes,
        outputTruncated: output.truncated,
        fullOutputAvailable: output.fullOutputAvailable,
      }),
      '',
      '[output]',
      output.preview || '[no output available]',
    ];
    if (output.truncated) {
      lines.push('', `[Truncated. Full output: ${output.outputPath ?? 'unavailable'}]`);
    }

    return { output: lines.join('\n'), isError: false };
  }
}
