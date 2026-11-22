/**
 * WaitForAllTool — wait for a whole cohort of background tasks under one deadline.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import {
  type BackgroundManager,
  type BackgroundTaskInfo,
  isBackgroundTaskTerminal,
} from '../../../agent/background';
import { agentTaskFor, formatBackgroundCapacity } from '../../../session/subagent-host';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import { formatPlainObject } from '../../background/format';
import { formatTaskList } from '../../background/task-list';
import WAIT_FOR_ALL_DESCRIPTION from './wait-for-all.md?raw';

/** Longest shared deadline accepted for a WaitForAll cohort, in seconds. */
export const WAIT_FOR_ALL_MAX_TIMEOUT_S = 1800;

// ── Input schema ─────────────────────────────────────────────────────

export const WaitForAllInputSchema = z
  .object({
    timeout: z
      .number()
      .int()
      .positive()
      .max(WAIT_FOR_ALL_MAX_TIMEOUT_S)
      .describe(
        `Maximum time to wait, in seconds (1-${String(WAIT_FOR_ALL_MAX_TIMEOUT_S)}). The deadline is shared by the whole cohort. A timeout is not an error: the tool returns the tasks that are still running, and you can call it again to keep waiting.`,
      ),
    agent_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Agent ids whose latest tasks form the cohort to wait for.'),
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Background task IDs that form the cohort to wait for. Omit both lists to wait for every task that is running at call time.',
      ),
  })
  .refine((value) => value.agent_ids === undefined || value.task_ids === undefined, {
    message: 'Provide agent_ids or task_ids, not both.',
  });

export type WaitForAllInput = z.infer<typeof WaitForAllInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

type CohortResolution =
  | { readonly tasks: readonly BackgroundTaskInfo[] }
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

export class WaitForAllTool implements BuiltinTool<WaitForAllInput> {
  readonly name = 'WaitForAll' as const;
  readonly description: string = WAIT_FOR_ALL_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WaitForAllInputSchema);

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: WaitForAllInput): ToolExecution {
    const subject = args.task_ids?.join(',') ?? args.agent_ids?.join(',') ?? 'all';
    return {
      description: `Waiting up to ${String(args.timeout)}s for ${cohortLabel(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: WaitForAllInput): Promise<ExecutableToolResult> {
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
        this.manager.wait(task.taskId, Math.max(0, deadline - Date.now())),
      ),
    );

    const finals = cohort.tasks.map(
      (task, index) => this.manager.getTask(task.taskId) ?? resolved[index] ?? task,
    );
    const finished = finals.filter((info) => isBackgroundTaskTerminal(info.status));
    if (finished.length > 0) {
      this.manager.markTasksDeliveredViaWait(
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
        backgroundCapacity: formatBackgroundCapacity(this.manager.capacity()),
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
    const running = this.manager.list(true);
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }

    return { output: lines.join('\n'), isError: false };
  }

  private resolveCohort(args: WaitForAllInput): CohortResolution {
    if (args.task_ids !== undefined) {
      const tasks: BackgroundTaskInfo[] = [];
      for (const taskId of args.task_ids) {
        const info = this.manager.getTask(taskId);
        if (info === undefined) return { error: `Task not found: ${taskId}` };
        tasks.push(info);
      }
      return { tasks };
    }

    if (args.agent_ids !== undefined) {
      const all = this.manager.list(false);
      const tasks: BackgroundTaskInfo[] = [];
      for (const agentId of args.agent_ids) {
        const info = agentTaskFor(all, agentId);
        if (info === undefined) return { error: `Agent not found: ${agentId}` };
        tasks.push(info);
      }
      return { tasks };
    }

    return { tasks: this.manager.list(true) };
  }
}
