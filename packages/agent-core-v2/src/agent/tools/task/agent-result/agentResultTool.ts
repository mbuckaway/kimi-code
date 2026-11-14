import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import { IAgentTaskService } from '#/agent/task/task';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject } from '#/agent/task/tools/format';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_MESSAGING_FLAG_ID } from '#/features/messaging/flag';
import { IAgentResultTool, AgentResultInputSchema, type AgentResultInput } from './agent-result';
import AGENT_RESULT_DESCRIPTION from './agent-result.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

export class AgentResultTool implements IAgentResultTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentResult' as const;
  readonly description: string = AGENT_RESULT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentResultInputSchema);

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

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
    if (!this.flags.enabled(AGENT_MESSAGING_FLAG_ID)) {
      return {
        isError: true,
        output: 'AgentResult is disabled: the agent_messaging experimental flag is off.',
      };
    }

    const task = agentTaskFor(this.tasks.list(false), args.agent_id);
    if (task === undefined) {
      return { isError: true, output: `No task found for agent: ${args.agent_id}` };
    }

    const output = await this.tasks.getOutputSnapshot(task.taskId, OUTPUT_PREVIEW_BYTES);
    const lines = [
      formatPlainObject({
        retrievalStatus: TERMINAL_STATUSES.has(task.status) ? 'success' : 'not_ready',
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
