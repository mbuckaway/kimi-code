import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import {
  applyStop,
  resolveStopReason,
  terminalStopReason,
} from '#/agent/tools/task/taskStopOps';
import { ITaskStopTool, TaskStopInputSchema, type TaskStopInput } from './task-stop';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

export class TaskStopTool implements ITaskStopTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async () => {
        const info = this.tasks.getTask(args.task_id);
        if (!info) {
          return { isError: true, output: `Task not found: ${args.task_id}` };
        }

        const reason = resolveStopReason(args.reason, 'Stopped by TaskStop');

        if (TERMINAL_STATUSES.has(info.status)) {
          return {
            output:
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              `reason: ${terminalStopReason(info, 'Task already in terminal state')}`,
            isError: false,
          };
        }

        const result = await applyStop(this.tasks, info, reason);
        if (!result) {
          return { isError: true, output: `Failed to stop task: ${args.task_id}` };
        }

        return {
          output:
            `task_id: ${result.taskId}\n` +
            `status: ${result.status}\n` +
            `reason: ${result.stopReason ?? reason}`,
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskStopTool, TaskStopTool, { name: 'TaskStop', domain: 'agentTask' });
