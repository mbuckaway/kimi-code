import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/task';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatBackgroundCapacity } from '#/agent/task/agentHealth';
import { formatPlainObject } from '#/agent/task/tools/format';
import { formatTaskList } from '#/agent/tools/task/task-list/taskListTool';
import { IWaitForAllTool, WaitForAllInputSchema, type WaitForAllInput } from './wait-for-all';
import WAIT_FOR_ALL_DESCRIPTION from './wait-for-all.md?raw';

type CohortResolution =
  | { readonly tasks: readonly AgentTaskInfo[] }
  | { readonly error: string };

function cohortLabel(args: WaitForAllInput): string {
  if (args.task_ids !== undefined) {
    return `${String(args.task_ids.length)} task${args.task_ids.length === 1 ? '' : 's'}`;
  }
  if (args.agent_ids !== undefined) {
    return `${String(args.agent_ids.length)} agent${args.agent_ids.length === 1 ? '' : 's'}`;
  }
  return 'all background tasks';
}

export class WaitForAllTool implements IWaitForAllTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WaitForAll' as const;
  readonly description: string = WAIT_FOR_ALL_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WaitForAllInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: WaitForAllInput): ToolExecution {
    const subject = args.task_ids?.join(',') ?? args.agent_ids?.join(',') ?? 'all';
    return {
      description: `Waiting up to ${String(args.timeout)}s for ${cohortLabel(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: WaitForAllInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const startedAt = Date.now();
    const timeoutMs = args.timeout * 1000;
    const deadline = startedAt + timeoutMs;
    const cohort = this.resolveCohort(args);
    if ('error' in cohort) return { isError: true, output: cohort.error };

    if (cohort.tasks.length === 0) {
      return {
        output: [
          formatPlainObject({ waitStatus: 'no_tasks', waitedMs: 0, timeoutMs }),
          'No background tasks are running, so there is nothing to wait for.',
        ].join('\n\n'),
        isError: false,
      };
    }

    const resolved = await Promise.all(
      cohort.tasks.map((task) =>
        this.tasks.wait(task.taskId, Math.max(0, deadline - Date.now()), ctx.signal),
      ),
    );

    const finals = cohort.tasks.map(
      (task, index) => this.tasks.getTask(task.taskId) ?? resolved[index] ?? task,
    );
    const finished = finals.filter((info) => TERMINAL_STATUSES.has(info.status));
    if (finished.length > 0) {
      this.tasks.markTasksDeliveredViaWait(
        finished.map((info) => ({ taskId: info.taskId, status: info.status })),
      );
    }
    const waitStatus =
      finished.length === cohort.tasks.length
        ? 'completed'
        : finished.length === 0
          ? 'timed_out'
          : 'partial';

    const lines = [
      formatPlainObject({
        waitStatus,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
        cohortCount: cohort.tasks.length,
        finishedCount: finished.length,
        backgroundCapacity: formatBackgroundCapacity(this.tasks.capacity()),
      }),
    ];
    if (finished.length > 0) {
      lines.push(
        '',
        '[finished]',
        finished
          .map((info) =>
            formatPlainObject({
              taskId: info.taskId,
              agentId: info.kind === 'agent' ? info.agentId : undefined,
              kind: info.kind,
              status: info.status,
              endedAt: info.endedAt,
              stopReason: info.stopReason,
            }),
          )
          .join('\n---\n'),
        'Use AgentResult with the agent_id or TaskOutput with the task_id to read each result.',
      );
    }
    const running = this.tasks.list(true);
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }

    return { output: lines.join('\n'), isError: false };
  }

  private resolveCohort(args: WaitForAllInput): CohortResolution {
    if (args.task_ids !== undefined) {
      const tasks: AgentTaskInfo[] = [];
      for (const taskId of args.task_ids) {
        const info = this.tasks.getTask(taskId);
        if (info === undefined) return { error: `Task not found: ${taskId}` };
        tasks.push(info);
      }
      return { tasks };
    }

    if (args.agent_ids !== undefined) {
      const all = this.tasks.list(false);
      const tasks: AgentTaskInfo[] = [];
      for (const agentId of args.agent_ids) {
        const info = agentTaskFor(all, agentId);
        if (info === undefined) return { error: `Agent not found: ${agentId}` };
        tasks.push(info);
      }
      return { tasks };
    }

    return { tasks: this.tasks.list(true) };
  }
}
