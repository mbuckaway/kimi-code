import { describe, expect, it } from 'vitest';

import { BugIndicatingError } from '#/errors';
import {
  deriveAgentHealth,
  formatBackgroundCapacity,
  type AgentHealthState,
} from '#/agent/task/agentHealth';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import type { AgentTaskInfo } from '#/agent/task/task';
import type { AgentTaskStatus } from '#/agent/task/types';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import type { ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';

function agentTask(overrides: Partial<SubagentTaskInfo> = {}): SubagentTaskInfo {
  return {
    taskId: 'agent-10000000',
    kind: 'agent',
    description: 'subagent task',
    status: 'running',
    startedAt: 100,
    endedAt: null,
    agentId: 'agent-1',
    ...overrides,
  };
}

function processTask(overrides: Partial<ProcessTaskInfo> = {}): ProcessTaskInfo {
  return {
    taskId: 'bash-10000000',
    kind: 'process',
    command: 'echo hello',
    description: 'process task',
    pid: 4242,
    status: 'running',
    startedAt: 100,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

const running = agentTask({
  taskId: 'agent-run00001',
  status: 'running',
  startedAt: 10,
  endedAt: null,
});
const completed = agentTask({
  taskId: 'agent-cmp00001',
  status: 'completed',
  startedAt: 50,
  endedAt: 60,
});
const olderRunning = agentTask({
  taskId: 'agent-old00001',
  status: 'running',
  startedAt: 10,
});
const newerRunning = agentTask({
  taskId: 'agent-new00001',
  status: 'running',
  startedAt: 20,
});
const earlyTerminal = agentTask({
  taskId: 'agent-early001',
  status: 'completed',
  startedAt: 10,
  endedAt: 100,
});
const lateTerminal = agentTask({
  taskId: 'agent-late0001',
  status: 'failed',
  startedAt: 20,
  endedAt: 200,
});

describe('agentTaskFor', () => {
  it('prefers the non-terminal task over a newer terminal task', () => {
    expect(agentTaskFor([completed, running], 'agent-1')).toBe(running);
  });

  it.each([
    { label: 'oldest first', tasks: [olderRunning, newerRunning] },
    { label: 'newest first', tasks: [newerRunning, olderRunning] },
  ])(
    'returns the latest-started running task when listed $label',
    ({ tasks }) => {
      expect(agentTaskFor(tasks, 'agent-1')).toBe(newerRunning);
    },
  );

  it.each([
    { label: 'oldest first', tasks: [earlyTerminal, lateTerminal] },
    { label: 'newest first', tasks: [lateTerminal, earlyTerminal] },
  ])(
    'returns the terminal task with the greatest endedAt when listed $label',
    ({ tasks }) => {
      expect(agentTaskFor(tasks, 'agent-1')).toBe(lateTerminal);
    },
  );

  it('falls back to startedAt when a terminal task has no endedAt', () => {
    const noEndedAt = agentTask({
      taskId: 'agent-null0001',
      status: 'killed',
      startedAt: 500,
      endedAt: null,
    });
    const endedEarly = agentTask({
      taskId: 'agent-end00001',
      status: 'completed',
      startedAt: 0,
      endedAt: 300,
    });

    expect(agentTaskFor([noEndedAt, endedEarly], 'agent-1')).toBe(noEndedAt);
  });

  it('ranks a later terminal task without endedAt by its startedAt', () => {
    const endedEarly = agentTask({
      taskId: 'agent-early002',
      status: 'completed',
      startedAt: 0,
      endedAt: 50,
    });
    const nullEndedLate = agentTask({
      taskId: 'agent-null0002',
      status: 'failed',
      startedAt: 400,
      endedAt: null,
    });

    expect(agentTaskFor([endedEarly, nullEndedLate], 'agent-1')).toBe(
      nullEndedLate,
    );
  });

  it('prefers a later-ended completed task over a lost task', () => {
    const lost = agentTask({
      taskId: 'agent-lost0001',
      status: 'lost',
      startedAt: 0,
      endedAt: 10,
    });
    const completedLater = agentTask({
      taskId: 'agent-cmp00002',
      status: 'completed',
      startedAt: 0,
      endedAt: 20,
    });

    expect(agentTaskFor([lost, completedLater], 'agent-1')).toBe(completedLater);
  });

  it('keeps the first task when terminal endedAt values tie', () => {
    const first = agentTask({
      taskId: 'agent-tie00001',
      status: 'completed',
      startedAt: 0,
      endedAt: 10,
    });
    const second = agentTask({
      taskId: 'agent-tie00002',
      status: 'failed',
      startedAt: 0,
      endedAt: 10,
    });

    expect(agentTaskFor([first, second], 'agent-1')).toBe(first);
  });

  it('ignores process tasks and other agents', () => {
    const process = processTask({ taskId: 'bash-irrelevant' });
    const foreign = agentTask({
      taskId: 'agent-foreign01',
      agentId: 'agent-2',
    });
    const match = agentTask({ taskId: 'agent-match001', agentId: 'agent-1' });

    expect(agentTaskFor([process, foreign, match], 'agent-1')).toBe(match);
  });

  it('returns undefined when no task matches the agent', () => {
    expect(agentTaskFor([agentTask()], 'agent-missing')).toBeUndefined();
  });

  it('returns undefined for an empty task list', () => {
    expect(agentTaskFor([], 'agent-1')).toBeUndefined();
  });
});

interface HealthCase {
  readonly name: string;
  readonly hasHandle: boolean;
  readonly loopState: 'idle' | 'running' | undefined;
  readonly task: AgentTaskInfo | undefined;
  readonly expected: AgentHealthState;
}

const healthCases: HealthCase[] = [
  {
    name: 'running loop state wins over an orphaned agent',
    hasHandle: false,
    loopState: 'running',
    task: agentTask({ status: 'completed', endedAt: 10 }),
    expected: 'running',
  },
  {
    name: 'running loop state wins with no task',
    hasHandle: true,
    loopState: 'running',
    task: undefined,
    expected: 'running',
  },
  {
    name: 'running loop state wins over a lost task',
    hasHandle: true,
    loopState: 'running',
    task: agentTask({ status: 'lost' }),
    expected: 'running',
  },
  {
    name: 'missing handle is orphaned even with a running task',
    hasHandle: false,
    loopState: 'idle',
    task: agentTask({ status: 'running' }),
    expected: 'orphaned',
  },
  {
    name: 'missing handle is orphaned with no task',
    hasHandle: false,
    loopState: undefined,
    task: undefined,
    expected: 'orphaned',
  },
  {
    name: 'idle loop without a task is idle',
    hasHandle: true,
    loopState: 'idle',
    task: undefined,
    expected: 'idle',
  },
  {
    name: 'undefined loop state without a task is idle',
    hasHandle: true,
    loopState: undefined,
    task: undefined,
    expected: 'idle',
  },
  {
    name: 'a lost task reports lost',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'lost' }),
    expected: 'lost',
  },
  {
    name: 'a running task without a running loop is stalled',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'running' }),
    expected: 'stalled',
  },
  {
    name: 'an undefined loop state with a running task is stalled',
    hasHandle: true,
    loopState: undefined,
    task: agentTask({ status: 'running' }),
    expected: 'stalled',
  },
  {
    name: 'a completed task reports completed',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'completed', endedAt: 10 }),
    expected: 'completed',
  },
  {
    name: 'a failed task reports failed',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'failed', endedAt: 10 }),
    expected: 'failed',
  },
  {
    name: 'a timed out task reports timed_out',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'timed_out', endedAt: 10 }),
    expected: 'timed_out',
  },
  {
    name: 'a killed task reports killed',
    hasHandle: true,
    loopState: 'idle',
    task: agentTask({ status: 'killed', endedAt: 10 }),
    expected: 'killed',
  },
];

describe('deriveAgentHealth', () => {
  it.each(healthCases)('$name', ({ hasHandle, loopState, task, expected }) => {
    expect(deriveAgentHealth({ hasHandle, loopState, task })).toBe(expected);
  });

  it('throws a bug-indicating error for a task status outside the union', () => {
    const task = agentTask({ status: 'bogus' as AgentTaskStatus });
    const act = (): AgentHealthState =>
      deriveAgentHealth({ hasHandle: true, loopState: 'idle', task });

    expect(act).toThrow(BugIndicatingError);
    expect(act).toThrow(/Unexpected task status: bogus/);
  });
});

describe('formatBackgroundCapacity', () => {
  it.each([
    { label: 'with a finite max', capacity: { running: 2, max: 5 }, expected: '2/5' },
    { label: 'at the finite max', capacity: { running: 5, max: 5 }, expected: '5/5' },
    { label: 'with a zero max', capacity: { running: 0, max: 0 }, expected: '0/0' },
    { label: 'with no max', capacity: { running: 0 }, expected: '0/unlimited' },
    {
      label: 'with an explicit undefined max',
      capacity: { running: 3, max: undefined },
      expected: '3/unlimited',
    },
  ])('formats capacity $label', ({ capacity, expected }) => {
    expect(formatBackgroundCapacity(capacity)).toBe(expected);
  });
});
