import { BugIndicatingError } from '#/_base/errors/errors';
import type { AgentTaskInfo } from './task';

export type AgentHealthState =
  | 'running'
  | 'stalled'
  | 'orphaned'
  | 'lost'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed';

export interface AgentHealthInput {
  readonly hasHandle: boolean;
  readonly loopState: 'idle' | 'running' | undefined;
  readonly task: AgentTaskInfo | undefined;
}

export function deriveAgentHealth(input: AgentHealthInput): AgentHealthState {
  if (input.loopState === 'running') return 'running';
  if (!input.hasHandle) return 'orphaned';

  const task = input.task;
  if (task === undefined) return 'idle';

  switch (task.status) {
    case 'running':
      return 'stalled';
    case 'lost':
      return 'lost';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'killed':
      return 'killed';
    default: {
      const status: never = task.status;
      throw new BugIndicatingError(`Unexpected task status: ${String(status)}`);
    }
  }
}

export function formatBackgroundCapacity(capacity: {
  readonly running: number;
  readonly max?: number;
}): string {
  return capacity.max === undefined
    ? `${capacity.running}/unlimited`
    : `${capacity.running}/${capacity.max}`;
}
