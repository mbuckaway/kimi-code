import type { AgentTaskInfo } from './task';
import { TERMINAL_STATUSES } from './types';

export function agentTaskFor(
  tasks: readonly AgentTaskInfo[],
  agentId: string,
): AgentTaskInfo | undefined {
  let active: AgentTaskInfo | undefined;
  let terminal: AgentTaskInfo | undefined;

  for (const task of tasks) {
    if (task.kind !== 'agent' || task.agentId !== agentId) continue;

    if (!TERMINAL_STATUSES.has(task.status)) {
      if (active === undefined || task.startedAt > active.startedAt) {
        active = task;
      }
      continue;
    }

    if (
      terminal === undefined ||
      (task.endedAt ?? task.startedAt) >
        (terminal.endedAt ?? terminal.startedAt)
    ) {
      terminal = task;
    }
  }

  return active ?? terminal;
}
