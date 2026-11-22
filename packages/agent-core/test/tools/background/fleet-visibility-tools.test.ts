/**
 * Covers: AgentResultTool, AgentHealthTool, WaitForAllTool.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type AgentBackgroundTaskInfo,
  type BackgroundManager,
  type BackgroundTaskOutputSnapshot,
  type ProcessBackgroundTaskInfo,
} from '../../../src/agent/background';
import type { AgentHealthState, SessionSubagentHost } from '../../../src/session/subagent-host';
import { AgentResultTool } from '../../../src/tools/builtin/collaboration/agent-result';
import { AgentHealthTool } from '../../../src/tools/builtin/collaboration/agent-health';
import {
  WaitForAllTool,
  WaitForAllInputSchema,
  WAIT_FOR_ALL_MAX_TIMEOUT_S,
} from '../../../src/tools/builtin/collaboration/wait-for-all';
import { executeTool } from '../fixtures/execute-tool';
import { toolContentString } from '../fixtures/fake-kaos';

const signal = new AbortController().signal;

function context<Input>(toolCallId: string, args: Input) {
  return { turnId: '0', toolCallId, args, signal };
}

function agentInfo(overrides: Partial<AgentBackgroundTaskInfo> = {}): AgentBackgroundTaskInfo {
  return {
    taskId: 'agent-abcdefgh',
    kind: 'agent',
    description: 'test agent task',
    status: 'completed',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_001,
    agentId: 'agent-1',
    subagentType: 'coder',
    ...overrides,
  };
}

function processInfo(
  overrides: Partial<ProcessBackgroundTaskInfo> = {},
): ProcessBackgroundTaskInfo {
  return {
    taskId: 'bash-abcdefgh',
    kind: 'process',
    command: 'sleep 60',
    pid: 1234,
    exitCode: 0,
    description: 'test process task',
    status: 'completed',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_001,
    ...overrides,
  };
}

function outputSnapshot(
  overrides: Partial<BackgroundTaskOutputSnapshot> = {},
): BackgroundTaskOutputSnapshot {
  return {
    outputSizeBytes: 6,
    previewBytes: 6,
    truncated: false,
    fullOutputAvailable: false,
    preview: 'RESULT',
    ...overrides,
  };
}

function mockManager() {
  return {
    list: vi.fn(),
    getTask: vi.fn(),
    getOutputSnapshot: vi.fn(),
    wait: vi.fn(),
    markTasksDeliveredViaWait: vi.fn(),
    capacity: vi.fn(),
  };
}

function mockHost(entries: readonly { agentId: string; running: boolean; state?: AgentHealthState }[]) {
  return {
    listAgents: vi.fn(() =>
      entries.map((entry) => ({
        agentId: entry.agentId,
        role: 'sub' as const,
        running: entry.running,
        state: entry.state,
      })),
    ),
  };
}

describe('AgentResultTool', () => {
  it('has name "AgentResult"', () => {
    const tool = new AgentResultTool(mockManager() as unknown as BackgroundManager);
    expect(tool.name).toBe('AgentResult');
  });

  it('returns an error when no task matches the agent id', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([]);

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_missing', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('No task found for agent: agent-1');
  });

  it('renders the task result and output preview for a finished agent', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo()]);
    manager.getOutputSnapshot.mockResolvedValue(outputSnapshot());

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_result', { agent_id: 'agent-1' }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(manager.list).toHaveBeenCalledWith(false);
    expect(manager.getOutputSnapshot).toHaveBeenCalledWith('agent-abcdefgh', 32 * 1024);
    expect(content).toContain('retrieval_status: success');
    expect(content).toContain('agent_id: agent-1');
    expect(content).toContain('status: completed');
    expect(content).toContain('[output]\nRESULT');
  });

  it('reports not_ready for a still-running agent task', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo({ status: 'running', endedAt: null })]);
    manager.getOutputSnapshot.mockResolvedValue(outputSnapshot());

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_running', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('retrieval_status: not_ready');
  });

  it('renders a truncation banner pointing at the persisted output path', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo()]);
    manager.getOutputSnapshot.mockResolvedValue(
      outputSnapshot({
        truncated: true,
        fullOutputAvailable: true,
        outputPath: '/tmp/tasks/agent-abcdefgh/output.log',
      }),
    );

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_truncated', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain(
      '[Truncated. Full output: /tmp/tasks/agent-abcdefgh/output.log]',
    );
  });

  it('renders an unavailable banner when truncated output has no persisted path', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo()]);
    manager.getOutputSnapshot.mockResolvedValue(
      outputSnapshot({ truncated: true, fullOutputAvailable: false }),
    );

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_truncated_no_path', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('[Truncated. Full output: unavailable]');
  });

  it('renders a no-output placeholder when the preview is empty', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo()]);
    manager.getOutputSnapshot.mockResolvedValue(
      outputSnapshot({ preview: '', previewBytes: 0, outputSizeBytes: 0 }),
    );

    const result = await executeTool(
      new AgentResultTool(manager as unknown as BackgroundManager),
      context('c_empty_output', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('[output]\n[no output available]');
  });
});

describe('AgentHealthTool', () => {
  it('has name "AgentHealth"', () => {
    const tool = new AgentHealthTool(
      mockManager() as unknown as BackgroundManager,
      mockHost([]) as unknown as SessionSubagentHost,
    );
    expect(tool.name).toBe('AgentHealth');
  });

  it('returns an error when the agent is not in the roster', async () => {
    const manager = mockManager();
    const host = mockHost([{ agentId: 'agent-2', running: false }]);

    const result = await executeTool(
      new AgentHealthTool(manager as unknown as BackgroundManager, host as unknown as SessionSubagentHost),
      context('c_roster_miss', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Agent not found: agent-1');
  });

  it('renders health, task, and capacity for a known idle agent', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo()]);
    manager.capacity.mockReturnValue({ running: 1, max: 2 });
    const host = mockHost([{ agentId: 'agent-1', running: false, state: 'completed' }]);

    const result = await executeTool(
      new AgentHealthTool(manager as unknown as BackgroundManager, host as unknown as SessionSubagentHost),
      context('c_health', { agent_id: 'agent-1' }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(host.listAgents).toHaveBeenCalledWith();
    expect(manager.list).toHaveBeenCalledWith(false);
    expect(manager.capacity).toHaveBeenCalledWith();
    expect(content).toContain('agent_id: agent-1');
    expect(content).toContain('state: completed');
    expect(content).toContain('loop_state: idle');
    expect(content).toContain('task_id: agent-abcdefgh');
    expect(content).toContain('task_status: completed');
    expect(content).toContain('background_capacity: 1/2');
  });

  it('renders running loop state when the roster marks the agent running', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([agentInfo({ status: 'running', endedAt: null })]);
    manager.capacity.mockReturnValue({ running: 2, max: 4 });
    const host = mockHost([{ agentId: 'agent-1', running: true, state: 'running' }]);

    const result = await executeTool(
      new AgentHealthTool(manager as unknown as BackgroundManager, host as unknown as SessionSubagentHost),
      context('c_health_running', { agent_id: 'agent-1' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('loop_state: running');
  });

  it('omits task fields when the agent has no background task', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([]);
    manager.capacity.mockReturnValue({ running: 0, max: undefined });
    const host = mockHost([{ agentId: 'agent-1', running: false, state: 'idle' }]);

    const result = await executeTool(
      new AgentHealthTool(manager as unknown as BackgroundManager, host as unknown as SessionSubagentHost),
      context('c_health_no_task', { agent_id: 'agent-1' }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('state: idle');
    expect(content).toContain('background_capacity: 0/unlimited');
    expect(content).not.toContain('task_id:');
    expect(content).not.toContain('task_status:');
  });
});

describe('WaitForAllTool', () => {
  it('has name "WaitForAll"', () => {
    const tool = new WaitForAllTool(mockManager() as unknown as BackgroundManager);
    expect(tool.name).toBe('WaitForAll');
  });

  it('rejects providing both agent_ids and task_ids', () => {
    const result = WaitForAllInputSchema.safeParse({
      timeout: 30,
      agent_ids: ['agent-1'],
      task_ids: ['task-1'],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    { label: 'zero', timeout: 0, valid: false },
    { label: 'the minimum', timeout: 1, valid: true },
    { label: 'the maximum', timeout: WAIT_FOR_ALL_MAX_TIMEOUT_S, valid: true },
    { label: 'over the maximum', timeout: WAIT_FOR_ALL_MAX_TIMEOUT_S + 1, valid: false },
    { label: 'a fraction', timeout: 1.5, valid: false },
  ])('validates the timeout boundary at $label', ({ timeout, valid }) => {
    expect(WaitForAllInputSchema.safeParse({ timeout }).success).toBe(valid);
  });

  it('returns no_tasks when no cohort task is running', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([]);

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_empty', { timeout: 30 }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(manager.list).toHaveBeenCalledWith(true);
    expect(content).toContain('wait_status: no_tasks');
    expect(content).toContain('No background tasks are running');
  });

  it('returns an error for an unknown task id', async () => {
    const manager = mockManager();
    manager.getTask.mockReturnValue(undefined);

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_unknown_task', { timeout: 30, task_ids: ['task-missing'] }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Task not found: task-missing');
  });

  it('returns an error for an unknown agent id', async () => {
    const manager = mockManager();
    manager.list.mockReturnValue([]);

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_unknown_agent', { timeout: 30, agent_ids: ['agent-missing'] }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Agent not found: agent-missing');
  });

  it('waits for task_ids and reports the finished cohort as completed', async () => {
    const manager = mockManager();
    manager.getTask.mockReturnValue(agentInfo({ taskId: 'task-1', agentId: 'agent-1' }));
    manager.wait.mockResolvedValue(agentInfo({ taskId: 'task-1', agentId: 'agent-1' }));
    manager.list.mockReturnValue([]);
    manager.capacity.mockReturnValue({ running: 0, max: undefined });

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_task_ids', { timeout: 30, task_ids: ['task-1'] }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('wait_status: completed');
    expect(content).toContain('cohort_count: 1');
    expect(content).toContain('finished_count: 1');
    expect(content).toContain('[finished]');
    expect(content).toContain('task_id: task-1');
    expect(manager.markTasksDeliveredViaWait).toHaveBeenCalledWith([
      { taskId: 'task-1', status: 'completed' },
    ]);
  });

  it('resolves the cohort from agent_ids', async () => {
    const manager = mockManager();
    manager.list.mockImplementation((activeOnly: boolean) =>
      activeOnly ? [] : [agentInfo()],
    );
    manager.wait.mockResolvedValue(agentInfo());
    manager.capacity.mockReturnValue({ running: 0, max: undefined });

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_agent_ids', { timeout: 30, agent_ids: ['agent-1'] }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('[finished]');
    expect(content).toContain('agent_id: agent-1');
  });

  it('reports timed_out with a still_running block when the cohort keeps running', async () => {
    const running = agentInfo({ status: 'running', endedAt: null });
    const manager = mockManager();
    manager.getTask.mockReturnValue(running);
    manager.wait.mockResolvedValue(running);
    manager.list.mockReturnValue([running]);
    manager.capacity.mockReturnValue({ running: 1, max: undefined });

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_timeout', { timeout: 1, task_ids: ['task-1'] }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('wait_status: timed_out');
    expect(content).toContain('finished_count: 0');
    expect(content).toContain('[still_running]');
    expect(manager.markTasksDeliveredViaWait).not.toHaveBeenCalled();
  });

  it('reports partial when some cohort tasks finish and others keep running', async () => {
    const running = agentInfo({ taskId: 'task-2', status: 'running', endedAt: null });
    const manager = mockManager();
    manager.getTask.mockImplementation((taskId: string) =>
      taskId === 'task-1'
        ? agentInfo({ taskId: 'task-1' })
        : running,
    );
    manager.wait.mockImplementation((taskId: string) =>
      Promise.resolve(taskId === 'task-1' ? agentInfo({ taskId: 'task-1' }) : running),
    );
    manager.list.mockReturnValue([running]);
    manager.capacity.mockReturnValue({ running: 1, max: 4 });

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_partial', { timeout: 30, task_ids: ['task-1', 'task-2'] }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('wait_status: partial');
    expect(content).toContain('finished_count: 1');
    expect(content).toContain('[finished]');
    expect(content).toContain('[still_running]');
    expect(manager.markTasksDeliveredViaWait).toHaveBeenCalledWith([
      { taskId: 'task-1', status: 'completed' },
    ]);
  });

  it('omits the agent_id for a finished process task', async () => {
    const manager = mockManager();
    manager.getTask.mockReturnValue(processInfo());
    manager.wait.mockResolvedValue(processInfo());
    manager.list.mockReturnValue([]);
    manager.capacity.mockReturnValue({ running: 0, max: undefined });

    const result = await executeTool(
      new WaitForAllTool(manager as unknown as BackgroundManager),
      context('c_process_task', { timeout: 30, task_ids: ['bash-abcdefgh'] }),
    );
    const content = toolContentString(result);

    expect(result.isError).toBe(false);
    expect(content).toContain('wait_status: completed');
    expect(content).toContain('kind: process');
    expect(content).not.toContain('agent_id:');
  });
});
