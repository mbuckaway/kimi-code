/**
 * StopAgentsTool — stop several background tasks or agents at once.
 *
 * The owning `SessionSubagentHost` resolves the requested tasks and reports one
 * row per request: `stopped`, `already_terminal`, `skipped_foreground`, or
 * `not_found`. Foreground tasks are excluded unless `include_foreground` is
 * true, because the caller may be waiting on them.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  formatBackgroundCapacity,
  MAX_STOP_REASON_CHARS,
  type SessionSubagentHost,
  type StopAgentsResult,
  type StopAgentsRow,
} from '../../../session/subagent-host';
import { formatPlainObject } from '../../background/format';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import STOP_AGENTS_DESCRIPTION from './stop-agents.md?raw';

export const StopAgentsInputSchema = z
  .object({
    agent_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Agent ids whose latest tasks to stop.'),
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Background task ids to stop.'),
    all: z
      .boolean()
      .optional()
      .describe('Stop every running background task selected by include_foreground.'),
    include_foreground: z
      .boolean()
      .optional()
      .describe('Also stop foreground tasks. Defaults to false.'),
    reason: z
      .string()
      .trim()
      .max(MAX_STOP_REASON_CHARS)
      .optional()
      .describe('Short reason recorded when each task is stopped.'),
  })
  .refine(
    (value) =>
      [value.agent_ids !== undefined, value.task_ids !== undefined, value.all === true].filter(
        Boolean,
      ).length === 1,
    { message: 'Provide exactly one of agent_ids, task_ids, or all=true.' },
  );

export type StopAgentsToolInput = z.infer<typeof StopAgentsInputSchema>;

export class StopAgentsTool implements BuiltinTool<StopAgentsToolInput> {
  readonly name = 'StopAgents' as const;
  readonly description: string = STOP_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(StopAgentsInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: StopAgentsToolInput): ToolExecution {
    const subject = args.task_ids?.join(',') ?? args.agent_ids?.join(',') ?? 'all';
    return {
      description: `Stopping ${stopTargetLabel(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: StopAgentsToolInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.subagentHost.stopAgents({
        agentIds: args.agent_ids,
        taskIds: args.task_ids,
        all: args.all,
        includeForeground: args.include_foreground,
        reason: args.reason,
      });
      return { output: formatStopAgentsResult(result), isError: false };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function stopTargetLabel(args: StopAgentsToolInput): string {
  if (args.task_ids !== undefined) {
    return `${String(args.task_ids.length)} task${args.task_ids.length === 1 ? '' : 's'}`;
  }
  if (args.agent_ids !== undefined) {
    return `${String(args.agent_ids.length)} agent${args.agent_ids.length === 1 ? '' : 's'}`;
  }
  return 'all background tasks';
}

function formatStopAgentsResult(result: StopAgentsResult): string {
  return [
    formatPlainObject({
      stopStatus: `${String(result.stopped)}/${String(result.requested)}`,
      backgroundCapacity: formatBackgroundCapacity(result.capacity),
    }),
    ...result.rows.map(formatStopRow),
  ].join('\n---\n');
}

function formatStopRow(row: StopAgentsRow): string {
  return formatPlainObject({
    taskId: row.taskId,
    agentId: row.agentId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
  });
}
