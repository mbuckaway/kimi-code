import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/task';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { TERMINAL_STATUSES, type AgentTaskKind } from '#/agent/task/types';
import { formatBackgroundCapacity } from '#/agent/task/agentHealth';
import { formatPlainObject } from '#/agent/task/tools/format';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_FLEET_CONTROL_FLAG_ID } from '#/features/messaging/flag';
import { IStopAgentsTool, StopAgentsInputSchema, type StopAgentsInput } from './task-stop-agents';
import STOP_AGENTS_DESCRIPTION from './task-stop-agents.md?raw';

type StopAgentsOutcome = 'stopped' | 'already_terminal' | 'skipped_foreground' | 'not_found';

interface RequestedStop {
  readonly selector: 'task' | 'agent';
  readonly id: string;
  readonly info: AgentTaskInfo | undefined;
}

interface StopAgentsRow {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly kind?: AgentTaskKind;
  readonly status: StopAgentsOutcome;
  readonly reason?: string;
}

const DEFAULT_STOP_REASON = 'Stopped by StopAgents';
const FOREGROUND_SKIPPED_REASON =
  'Foreground task skipped; set include_foreground=true to stop it.';
const DISABLED_MESSAGE =
  'StopAgents is disabled: the agent_fleet_control experimental flag is off.';

function stopTargetLabel(args: StopAgentsInput): string {
  if (args.task_ids !== undefined) {
    return `${String(args.task_ids.length)} task${args.task_ids.length === 1 ? '' : 's'}`;
  }
  if (args.agent_ids !== undefined) {
    return `${String(args.agent_ids.length)} agent${args.agent_ids.length === 1 ? '' : 's'}`;
  }
  return 'all background tasks';
}

function resolveStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? DEFAULT_STOP_REASON : trimmed;
}

function terminalReason(info: AgentTaskInfo): string {
  const stored = info.stopReason?.trim();
  return stored === undefined || stored.length === 0 ? `Task already ${info.status}` : stored;
}

function outcomeRow(
  info: AgentTaskInfo,
  status: StopAgentsOutcome,
  reason: string,
): StopAgentsRow {
  return {
    taskId: info.taskId,
    agentId: info.kind === 'agent' ? info.agentId : undefined,
    kind: info.kind,
    status,
    reason,
  };
}

function notFoundRow(entry: RequestedStop): StopAgentsRow {
  return entry.selector === 'agent'
    ? { agentId: entry.id, status: 'not_found', reason: 'No task found for agent' }
    : { taskId: entry.id, status: 'not_found', reason: 'Task not found' };
}

export class StopAgentsTool implements IStopAgentsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'StopAgents' as const;
  readonly description: string = STOP_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(StopAgentsInputSchema);

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  resolveExecution(args: StopAgentsInput): ToolExecution {
    const subject = args.task_ids?.join(',') ?? args.agent_ids?.join(',') ?? 'all';
    return {
      description: `Stopping ${stopTargetLabel(args)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: StopAgentsInput): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(AGENT_FLEET_CONTROL_FLAG_ID)) {
      return { isError: true, output: DISABLED_MESSAGE };
    }

    const reason = resolveStopReason(args.reason);
    const requested = this.resolveRequested(args);
    const includeForeground = args.include_foreground === true;
    const rows: StopAgentsRow[] = [];
    let stopped = 0;

    for (const entry of requested) {
      const info = entry.info;
      if (info === undefined) {
        rows.push(notFoundRow(entry));
        continue;
      }
      if (TERMINAL_STATUSES.has(info.status)) {
        rows.push(outcomeRow(info, 'already_terminal', terminalReason(info)));
        continue;
      }
      if (!includeForeground && info.detached === false) {
        rows.push(outcomeRow(info, 'skipped_foreground', FOREGROUND_SKIPPED_REASON));
        continue;
      }
      await this.tasks.suppressTerminalNotification(info.taskId);
      await this.tasks.stop(info.taskId, reason);
      stopped += 1;
      rows.push(outcomeRow(info, 'stopped', reason));
    }

    return {
      output: [
        formatPlainObject({
          stopStatus: `${String(stopped)}/${String(requested.length)}`,
          backgroundCapacity: formatBackgroundCapacity(this.tasks.capacity()),
        }),
        ...rows.map((row) => formatPlainObject(row)),
      ].join('\n---\n'),
      isError: false,
    };
  }

  private resolveRequested(args: StopAgentsInput): readonly RequestedStop[] {
    if (args.task_ids !== undefined) {
      return args.task_ids.map((taskId) => ({
        selector: 'task' as const,
        id: taskId,
        info: this.tasks.getTask(taskId),
      }));
    }
    if (args.agent_ids !== undefined) {
      const agentTasks = this.tasks.list(false);
      return args.agent_ids.map((agentId) => ({
        selector: 'agent' as const,
        id: agentId,
        info: agentTaskFor(agentTasks, agentId),
      }));
    }
    return this.tasks.list(true).map((info) => ({
      selector: 'task' as const,
      id: info.taskId,
      info,
    }));
  }
}
