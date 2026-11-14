import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import { formatPlainObject } from '#/agent/task/tools/format';
import {
  OUTPUT_PREVIEW_BYTES,
  fullOutputHintOf,
  retrievalStatus,
  terminalReasonOf,
} from '#/agent/tools/task/taskOutputView';
import { ITaskOutputTool, TaskOutputInputSchema, type TaskOutputInput } from './task-output';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

export class TaskOutputTool implements ITaskOutputTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    const output = await this.tasks.getOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES);

    const lines = [
      formatPlainObject({
        retrievalStatus: retrievalStatus(current.status),
        ...current,
        outputPath: output.outputPath,
        terminalReason: terminalReasonOf(current),
        outputSizeBytes: output.outputSizeBytes,
        outputPreviewBytes: output.previewBytes,
        outputTruncated: output.truncated,
        fullOutputAvailable: output.fullOutputAvailable,
        fullOutputTool:
          output.fullOutputAvailable && output.outputPath !== undefined ? 'Read' : undefined,
        fullOutputHint: fullOutputHintOf(output),
      }),
      '',
    ];

    if (output.truncated) {
      lines.push(
        output.fullOutputAvailable && output.outputPath !== undefined
          ? `[Truncated. Full output: ${output.outputPath}]`
          : '[Truncated. No persisted full log is available for this task.]',
      );
    }
    lines.push('[output]', output.preview || '[no output available]');

    return {
      output: lines.join('\n'),
      isError: false,
    };
  }
}

registerAgentToolService(ITaskOutputTool, TaskOutputTool, { name: 'TaskOutput', domain: 'agentTask' });
