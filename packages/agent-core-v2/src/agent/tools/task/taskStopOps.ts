import type { AgentTaskInfo, IAgentTaskService } from '#/agent/task/task';

export function resolveStopReason(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? fallback : trimmed;
}

export function terminalStopReason(info: AgentTaskInfo, fallback: string): string {
  const stored = info.stopReason?.trim();
  return stored === undefined || stored.length === 0 ? fallback : stored;
}

export async function applyStop(
  tasks: Pick<IAgentTaskService, 'suppressTerminalNotification' | 'stop'>,
  info: AgentTaskInfo,
  reason: string,
): Promise<AgentTaskInfo | undefined> {
  await tasks.suppressTerminalNotification(info.taskId);
  return tasks.stop(info.taskId, reason);
}
