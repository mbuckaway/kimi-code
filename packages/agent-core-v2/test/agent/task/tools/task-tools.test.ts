import { PassThrough, Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskCapacity,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskTrackOptions,
  type AgentTaskWaitDelivery,
  type ForegroundTaskReleaseReason,
  type IAgentTaskEntry,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TaskListInputSchema } from '#/agent/tools/task/task-list/task-list';
import { TaskListTool } from '#/agent/tools/task/task-list/taskListTool';
import { TaskOutputInputSchema } from '#/agent/tools/task/task-output/task-output';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { TaskStopInputSchema } from '#/agent/tools/task/task-stop/task-stop';
import { TaskStopTool } from '#/agent/tools/task/task-stop/taskStopTool';
import { WaitForInputSchema } from '#/agent/tools/task/task-wait/task-wait';
import { WaitForTool, startWaitProgress, waitForProgressUpdate } from '#/agent/tools/task/task-wait/taskWaitTool';
import { abortError } from '#/_base/utils/abort';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import { makeAgentScopeContext, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { UsageStatus } from '#/agent/usage/usage';
import { AgentResultInputSchema } from '#/agent/tools/task/agent-result/agent-result';
import { AgentResultTool } from '#/agent/tools/task/agent-result/agentResultTool';
import { AgentHealthInputSchema } from '#/agent/tools/task/agent-status/agent-status';
import { AgentHealthTool } from '#/agent/tools/task/agent-status/agentStatusTool';
import {
  WAIT_FOR_ALL_MAX_TIMEOUT_S,
  WaitForAllInputSchema,
  type WaitForAllInput,
} from '#/agent/tools/task/task-wait-all/wait-for-all';
import { WaitForAllTool } from '#/agent/tools/task/task-wait-all/waitForAllTool';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import {
  StopAgentsInputSchema,
  type StopAgentsInput,
} from '#/agent/tools/task/task-stop-agents/task-stop-agents';
import { StopAgentsTool } from '#/agent/tools/task/task-stop-agents/taskStopAgentsTool';
import { AGENT_FLEET_CONTROL_FLAG_ID, AGENT_MESSAGING_FLAG_ID } from '#/features/messaging/flag';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import type { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { ToolExecution } from '#/tool/toolContract';
import type { ITaskHandle } from '#/app/task/task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import { ProcessTask, type ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import { IWaitForTool } from '#/agent/tools/task/task-wait/task-wait';
import { IAgentLoopService } from '#/agent/loop/loop';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../../../app/telemetry/stubs';
import { stubFlag } from '../../../app/flag/stubs';
import { agentService, createTestAgent, telemetryServices } from '../../../harness';
import { stubLoopWithHooks } from '../../loop/stubs';

const signal = new AbortController().signal;

function context<Input>(
  toolCallId: string,
  args: Input,
  executionSignal: AbortSignal = signal,
) {
  return { turnId: 0, toolCallId, args, signal: executionSignal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function processTask(
  overrides: Partial<ProcessTaskInfo> = {},
): ProcessTaskInfo {
  return {
    taskId: 'bash-abc12345',
    kind: 'process',
    command: 'sleep 60',
    description: 'test task',
    pid: 12345,
    exitCode: null,
    status: 'running',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    ...overrides,
  };
}

function agentTaskInfo(
  overrides: Partial<SubagentTaskInfo> = {},
): SubagentTaskInfo {
  return {
    taskId: 'agent-abc12345',
    kind: 'agent',
    description: 'agent task',
    agentId: 'agent-child',
    subagentType: 'coder',
    status: 'completed',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function outputSnapshot(
  preview = '',
  overrides: Partial<AgentTaskOutputSnapshot> = {},
): AgentTaskOutputSnapshot {
  const size = Buffer.byteLength(preview);
  return {
    outputSizeBytes: size,
    previewBytes: size,
    truncated: false,
    fullOutputAvailable: false,
    preview,
    ...overrides,
  };
}

interface FakeTaskEntry {
  info: AgentTaskInfo;
  output: AgentTaskOutputSnapshot;
}

class FakeTaskService implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  readonly stopCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  readonly suppressCalls: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];
  readonly waitDeliveries: Array<readonly AgentTaskWaitDelivery[]> = [];
  waitDelegate:
    | ((
        taskId: string,
        timeoutMs: number | undefined,
        signal: AbortSignal | undefined,
      ) => Promise<AgentTaskInfo | undefined>)
    | undefined;

  private readonly entries = new Map<string, FakeTaskEntry>();

  add(
    info: AgentTaskInfo,
    output: AgentTaskOutputSnapshot = outputSnapshot(),
  ): string {
    this.entries.set(info.taskId, { info, output });
    return info.taskId;
  }

  settle(taskId: string, status: AgentTaskStatus = 'completed'): void {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      status,
      endedAt: entry.info.endedAt ?? 1_700_000_002_000,
    } as AgentTaskInfo;
  }

  track(_handle: ITaskHandle, _options: AgentTaskTrackOptions): IAgentTaskEntry {
    throw new Error('track is not implemented in FakeTaskService.');
  }

  registerTask(_task: AgentTask, _options?: RegisterAgentTaskOptions): string {
    throw new Error('registerTask is not implemented in FakeTaskService.');
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    return this.entries.get(taskId)?.info;
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    for (const entry of this.entries.values()) {
      const info = entry.info;
      if (activeOnly && TERMINAL_STATUSES.has(info.status)) continue;
      if (!activeOnly && TERMINAL_STATUSES.has(info.status) && info.detached === false) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  capacityOverride: AgentTaskCapacity | undefined;

  capacity(): AgentTaskCapacity {
    if (this.capacityOverride !== undefined) return this.capacityOverride;
    let running = 0;
    for (const entry of this.entries.values()) {
      if (TERMINAL_STATUSES.has(entry.info.status)) continue;
      if (entry.info.detached === false) continue;
      running++;
    }
    return { running };
  }

  persistOutput(_taskId: string): void {}

  readonly failSnapshotTaskIds = new Set<string>();

  async getOutputSnapshot(
    taskId: string,
    _maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    if (this.failSnapshotTaskIds.has(taskId)) throw new Error('snapshot read failed');
    return this.entries.get(taskId)?.output ?? outputSnapshot();
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const preview = this.entries.get(taskId)?.output.preview ?? '';
    if (tail === undefined) return preview;
    return preview.slice(-Math.max(0, Math.trunc(tail)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressCalls.push(taskId);
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      terminalNotificationSuppressed: true,
    } as AgentTaskInfo;
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    this.waitDeliveries.push(tasks);
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    entry.info = {
      ...entry.info,
      detached: true,
    } as AgentTaskInfo;
    return entry.info;
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    this.stopCalls.push({ taskId, reason });
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.info.status)) return entry.info;
    entry.info = {
      ...entry.info,
      status: 'killed',
      endedAt: 1_700_000_002_000,
      stopReason: reason,
      ...(entry.info.kind === 'process' ? { exitCode: 143 } : undefined),
    } as AgentTaskInfo;
    return entry.info;
  }

  async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.stop(taskId, 'Aborted by the user');
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const stopped = await Promise.all(
      Array.from(this.entries.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return stopped.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    return this.stopAll(reason);
  }

  async wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    this.waitCalls.push({ taskId, timeoutMs });
    if (this.waitDelegate !== undefined) {
      return this.waitDelegate(taskId, timeoutMs, signal);
    }
    return this.entries.get(taskId)?.info;
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    return this.entries.has(taskId) ? 'detached' : undefined;
  }
}

describe('TaskListTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskListTool(new FakeTaskService());

    expect(tool.name).toBe('TaskList');
    expect(TaskListInputSchema.safeParse({}).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 1 }).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 0 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    });
  });

  it('returns the empty active-task message', async () => {
    const result = await executeTool(
      new TaskListTool(new FakeTaskService()),
      context('task_list_empty', { active_only: true }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain(
      'active_background_tasks: 0\nNo background tasks found.',
    );
  });

  it('lists active process tasks', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-running1',
        command: 'sleep 60',
        description: 'running list',
      }),
    );

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_active', { active_only: true }),
    );
    const output = outputString(result);

    expect(output).toMatch(/^active_background_tasks:\s*1/);
    expect(output).toContain('kind: process');
    expect(output).toContain('task_id: bash-running1');
    expect(output).toContain('command: sleep 60');
    expect(output).toContain('description: running list');
  });

  it(
    'excludes terminal tasks from active_only=true and includes them when all tasks are listed',
    async () => {
      const tasks = new FakeTaskService();
      const taskId = tasks.add(
        processTask({
          taskId: 'bash-failed01',
          command: 'exit 7',
          description: 'exit code test',
          status: 'failed',
          endedAt: 1_700_000_001_000,
          exitCode: 7,
        }),
      );

      const active = await executeTool(
        new TaskListTool(tasks),
        context('task_list_active_terminal', { active_only: true }),
      );
      expect(outputString(active)).toContain(
        'active_background_tasks: 0\nNo background tasks found.',
      );

      const all = await executeTool(
        new TaskListTool(tasks),
        context('task_list_all_terminal', { active_only: false }),
      );
      const output = outputString(all);

      expect(output).toMatch(/^background_tasks:\s*1/);
      expect(output).toContain(taskId);
      expect(output).toContain('status: failed');
      expect(output).toContain('exit_code: 7');
    },
  );

  it('honours the limit parameter', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-first001', description: 'one' }));
    tasks.add(processTask({ taskId: 'bash-second01', description: 'two' }));

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_limit', { active_only: true, limit: 1 }),
    );
    const output = outputString(result);

    expect(output).toContain('active_background_tasks: 1');
    expect(output).toContain('bash-first001');
    expect(output).not.toContain('bash-second01');
  });

  it('includes stop_reason for stopped tasks in all-tasks view', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-stopped1',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'superseded by newer task',
      }),
    );

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_stop_reason', { active_only: false }),
    );

    expect(outputString(result)).toContain('stop_reason: superseded by newer task');
  });

  it('does not wait when listing a running task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running2', description: 'running task' }));
    const wait = vi.spyOn(tasks, 'wait');

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_no_wait', { active_only: true }),
    );

    expect(outputString(result)).toContain('running task');
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('TaskOutputTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskOutputTool(new FakeTaskService());

    expect(tool.name).toBe('TaskOutput');
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
      },
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"block"');
    expect(JSON.stringify(tool.parameters)).not.toContain('"timeout"');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskOutputTool(new FakeTaskService()),
      context('task_output_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  });

  it('returns live output when no persisted log is available', async () => {
    const tasks = new FakeTaskService();
    const payload = 'DETACHED-PAYLOAD-LINE\n';
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-live0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot(payload),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_live', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(result).toMatchObject({ isError: false });
    expect(output).toContain('retrieval_status: success');
    expect(output).toContain('status: completed');
    expect(output).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(output).toContain(`output_size_bytes: ${Buffer.byteLength(payload).toString()}`);
    expect(output).not.toContain('output_path:');
  });

  it('returns persisted output path and guidance when a log is available', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-persist1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('STDOUT-PAYLOAD-LINE\n', {
        outputPath: '/tmp/session/tasks/bash-persist1/output.log',
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_persisted', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: completed');
    expect(output).toContain('output_path: /tmp/session/tasks/bash-persist1/output.log');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).toContain('full_output_hint:');
    expect(output).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
  });

  it('returns agent metadata and final summary without process fields', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo(), outputSnapshot('SUBAGENT-FINAL-SUMMARY\n'));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_agent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('kind: agent');
    expect(output).toContain('agent_id: agent-child');
    expect(output).toContain('subagent_type: coder');
    expect(output).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(output).not.toMatch(/^pid:/m);
    expect(output).not.toMatch(/^command:/m);
    expect(output).not.toMatch(/^exit_code:/m);
  });

  it('returns not_ready for non-blocking running tasks', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-running3' }));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_not_ready', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('retrieval_status: not_ready');
    expect(output).toContain('status: running');
    expect(output).not.toContain('next_step');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('rejects stale block/timeout args at the validator instead of waiting', () => {
    const validator = compileToolArgsValidator(new TaskOutputTool(new FakeTaskService()).parameters);

    expect(validateToolArgs(validator, { task_id: 'bash-1' })).toBeNull();
    const stale = validateToolArgs(validator, { task_id: 'bash-1', block: true, timeout: 1 });
    expect(stale).toContain("must NOT have additional property 'block'");
    expect(stale).toContain("must NOT have additional property 'timeout'");
  });

  it('surfaces timeout terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-timeout1',
        status: 'timed_out',
        endedAt: 1_700_000_001_000,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_timed_out', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: timed_out');
    expect(output).not.toContain('stop_reason:');
    expect(output).toContain('terminal_reason: timed_out');
  });

  it('surfaces stopped terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-stopped2',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'operator cancelled',
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_stopped', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: killed');
    expect(output).toContain('stop_reason: operator cancelled');
    expect(output).toContain('terminal_reason: stopped');
  });

  it('does not advertise output_path when the persisted log file does not exist', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-silent01',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_silent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).not.toContain('output_path:');
    expect(output).toContain('output_size_bytes: 0');
    expect(output).toContain('full_output_available: false');
    expect(output).toContain('[output]\n[no output available]');
  });

  it('renders a truncation banner and tail preview when the snapshot is truncated', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-trunc001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('TAIL-MARKER\n', {
        outputPath: '/tmp/session/tasks/bash-trunc001/output.log',
        outputSizeBytes: 200 * 1024,
        previewBytes: 32 * 1024,
        truncated: true,
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_truncated', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('output_truncated: true');
    expect(output).toContain('output_size_bytes: 204800');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).toContain(
      '[Truncated. Full output: /tmp/session/tasks/bash-trunc001/output.log]',
    );
    expect(output).toContain('TAIL-MARKER');
  });
});

describe('TaskStopTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskStopTool(new FakeTaskService());

    expect(tool.name).toBe('TaskStop');
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1', reason: '' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
    });
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskStopTool(new FakeTaskService()),
      context('task_stop_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  });

  it('stops a running task, records the reason, and suppresses terminal notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-stop0001' }));

    const result = await executeTool(
      new TaskStopTool(tasks),
      context('task_stop_running', { task_id: taskId, reason: 'custom stop reason' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('task_id: bash-stop0001');
    expect(output).toContain('status: killed');
    expect(output).toContain('reason: custom stop reason');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'custom stop reason' }]);
    expect(tasks.suppressCalls).toEqual([taskId]);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'killed',
      stopReason: 'custom stop reason',
      terminalNotificationSuppressed: true,
    });
  });

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-default1' }));

    const result = await executeTool(
      new TaskStopTool(tasks),
      context('task_stop_default_reason', { task_id: taskId, reason }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('reason: Stopped by TaskStop');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'Stopped by TaskStop' }]);
    expect(tasks.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  });

  it('returns info when task is already terminal without suppressing notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      new TaskStopTool(tasks),
      context('task_stop_terminal', { task_id: taskId }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')).toEqual([
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(tasks.suppressCalls).toEqual([]);
    expect(tasks.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  });

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-blank001',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: '',
      }),
    );

    const result = await executeTool(
      new TaskStopTool(tasks),
      context('task_stop_blank_stored_reason', { task_id: 'bash-blank001' }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')[2]).toBe(
      'reason: Task already in terminal state',
    );
  });
});

describe('WaitForTool', () => {
  function waitTelemetry(): { records: TelemetryRecord[]; telemetry: ReturnType<typeof recordingTelemetry> } {
    const records: TelemetryRecord[] = [];
    return { records, telemetry: recordingTelemetry(records) };
  }

  function lastEvent(records: TelemetryRecord[]): TelemetryRecord | undefined {
    return records.findLast((record) => record.event === 'wait_for_completed');
  }

  it('has name and accepts the current schema', () => {
    const tool = new WaitForTool(new FakeTaskService(), recordingTelemetry([]), stubFlag(true));

    expect(tool.name).toBe('WaitFor');
    expect(WaitForInputSchema.safeParse({ timeout: 60 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 60, task_id: 'bash-1' }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 600 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({}).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: -5 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 601 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 1.5 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['timeout'],
      properties: {
        timeout: { type: 'integer' },
        task_id: { type: 'string' },
      },
    });
  });

  it('returns error and tracks task_not_found for an unknown task_id', async () => {
    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      new WaitForTool(new FakeTaskService(), telemetry, stubFlag(true)),
      context('wait_unknown', { timeout: 10, task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'task_not_found',
      timeout_ms: 10_000,
      has_task_id: true,
      extra_completed_count: 0,
    });
  });

  it('returns immediately without waiting when no background tasks are running', async () => {
    const tasks = new FakeTaskService();
    const result = await executeTool(
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_none', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: no_tasks');
    expect(output).toContain('No background tasks are running');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('returns a finished task immediately and marks it delivered via wait', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0002',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('DONE-OUTPUT\n'),
    );

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_done', { timeout: 10, task_id: taskId }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('status: completed');
    expect(output).toContain('[finished]');
    expect(output).toContain('[output]\nDONE-OUTPUT');
    expect(tasks.waitDeliveries).toEqual([[{ taskId, status: 'completed' }]]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: true,
      extra_completed_count: 0,
    });
  });

  it('reports tasks that finished during the wait and marks all of them delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wait001', description: 'main wait' }), outputSnapshot('WAITED-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-extra001', description: 'side task' }));
    tasks.waitDelegate = async (taskId) => {
      tasks.settle('bash-wait001');
      tasks.settle('bash-extra001', 'failed');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_extras', { timeout: 10, task_id: 'bash-wait001' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('[completed_during_wait]');
    expect(output).toContain('task_id: bash-extra001');
    expect(output).toContain('status: failed');
    expect(tasks.waitDeliveries).toEqual([
      [
        { taskId: 'bash-wait001', status: 'completed' },
        { taskId: 'bash-extra001', status: 'failed' },
      ],
    ]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      extra_completed_count: 1,
    });
  });

  it('waits for any running task when task_id is omitted', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-a1', description: 'task A' }), outputSnapshot('A-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-b1', description: 'task B' }));
    tasks.waitDelegate = async (taskId) => {
      if (taskId === 'bash-a1') tasks.settle('bash-a1');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_any', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('task_id: bash-a1');
    expect(output).toContain('[output]\nA-OUT');
    expect(output).toContain('[still_running]');
    expect(output).toContain('task_id: bash-b1');
    expect(tasks.waitCalls).toHaveLength(2);
    expect(tasks.waitDeliveries).toEqual([[{ taskId: 'bash-a1', status: 'completed' }]]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: false,
      extra_completed_count: 0,
    });
  });

  it('returns the still-running list on timeout without marking anything delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running9', description: 'slow task' }));

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_timeout', { timeout: 10, task_id: 'bash-running9' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: timed_out');
    expect(output).toContain('not an error');
    expect(output).toContain('[still_running]');
    expect(output).toContain('bash-running9');
    expect(tasks.waitDeliveries).toEqual([]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'timed_out',
      timeout_ms: 10_000,
      has_task_id: true,
    });
  });

  it('propagates an abort of the execution signal and tracks the aborted outcome', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort01' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const { records, telemetry } = waitTelemetry();
    const controller = new AbortController();
    const pending = executeTool(
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_abort', { timeout: 600, task_id: 'bash-abort01' }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.waitDeliveries).toEqual([]);
    expect(lastEvent(records)?.properties).toMatchObject({ outcome: 'aborted' });
  });

  it('propagates an abort from a general wait and leaves tasks running', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort02' }));
    tasks.add(processTask({ taskId: 'bash-abort03' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const controller = new AbortController();
    const pending = executeTool(
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_abort_any', { timeout: 600 }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.getTask('bash-abort02')?.status).toBe('running');
    expect(tasks.getTask('bash-abort03')?.status).toBe('running');
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('does not mark tasks delivered when formatting the result fails', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-fmtfail1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );
    tasks.failSnapshotTaskIds.add(taskId);

    await expect(
      executeTool(
        new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
        context('wait_fmt_fail', { timeout: 10, task_id: taskId }),
      ),
    ).rejects.toThrow('snapshot read failed');
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('aborts the losing waits once the race resolves', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-win0001' }));
    tasks.add(processTask({ taskId: 'bash-lose001' }));
    const signals = new Map<string, AbortSignal>();
    tasks.waitDelegate = (taskId, _timeoutMs, waitSignal) => {
      signals.set(taskId, waitSignal!);
      if (taskId === 'bash-win0001') {
        tasks.settle('bash-win0001');
        return Promise.resolve(tasks.getTask(taskId));
      }
      return new Promise<AgentTaskInfo | undefined>(() => {});
    };

    const result = await executeTool(
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_losers', { timeout: 600 }),
    );

    expect(outputString(result)).toContain('wait_status: completed');
    expect(signals.get('bash-lose001')?.aborted).toBe(true);
  });

  it('rejects execution when the wait_for flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-flagoff1' }));

    const result = await executeTool(
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(false)),
      context('wait_flag_off', { timeout: 10, task_id: 'bash-flagoff1' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('wait_for experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('emits status progress updates while the wait is pending', async () => {
    const update = waitForProgressUpdate({ timeout: 600 }, 2, 1_000, 31_000);
    expect(update).toMatchObject({
      kind: 'status',
      replace: true,
      text: 'Waiting 30s / 10m · 2 background tasks still running',
    });
    expect(waitForProgressUpdate({ timeout: 600 }, 1, 1_000, 31_000).text).toContain(
      '1 background task still running',
    );
    expect(waitForProgressUpdate({ timeout: 600 }, 0, 1_000, 31_000).text).toContain(
      '0 background tasks still running',
    );
    expect(waitForProgressUpdate({ timeout: 600 }, 1, 1_000, 76_000).text).toContain(
      'Waiting 1m 15s / 10m',
    );
    expect(waitForProgressUpdate({ timeout: 180 }, 1, 1_000, 61_000).text).toContain(
      'Waiting 1m / 3m',
    );
  });

  it('routes the composed progress update through onUpdate on a manual tick', () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-prog002' }));
    const onUpdate = vi.fn();

    const progress = startWaitProgress({ timeout: 600 }, tasks, onUpdate, Date.now() - 30_000);
    progress.tick();
    progress.stop();

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'status',
        replace: true,
        text: expect.stringMatching(/^Waiting 3\ds \/ 10m · 1 background task still running$/),
      }),
    );
  });
});

describe('WaitForTool (harness)', () => {
  function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from(stdoutText ? [stdoutText] : []),
      stderr: Readable.from([]),
      pid: 10000 + exitCode,
      exitCode,
      wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }

  function controllableProcess(): {
    proc: IHostProcess;
    pushOutput: (text: string) => void;
    resolveWait: (code: number) => void;
  } {
    const stdout = new PassThrough();
    let resolveWait!: (code: number) => void;
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid: 10099,
      exitCode: null,
      wait: vi.fn(() => waitPromise) as IHostProcess['wait'],
      kill: vi.fn(async () => {
        stdout.destroy();
        resolveWait(143);
      }) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    } as IHostProcess;
    return {
      proc,
      pushOutput: (text) => {
        stdout.write(text);
      },
      resolveWait: (code) => {
        stdout.end();
        resolveWait(code);
      },
    };
  }

  async function waitForTerminal(tasks: IAgentTaskService, taskId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const info = await tasks.wait(taskId, 5);
      if (info !== undefined && TERMINAL_STATUSES.has(info.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for task to terminate: ${taskId}`);
  }

  it('waits for a real registered task end-to-end and suppresses its notification', async () => {
    const records: TelemetryRecord[] = [];
    const loop = stubLoopWithHooks();
    const ctx = createTestAgent(
      telemetryServices(recordingTelemetry(records)),
      agentService(IAgentLoopService, loop),
    );
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('WaitFor');
      expect(tool).toBeDefined();

      const slow = controllableProcess();
      const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'echo done', 'wait target'));
      const pending = executeTool(tool!, context('wait_e2e', { timeout: 30, task_id: taskId }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      slow.pushOutput('DONE-OUTPUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskId}`);
      expect(output).toContain('[finished]');
      expect(output).toContain('[output]\nDONE-OUTPUT');
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(true);

      expect(loop.hasPendingRequests()).toBe(false);
      loop.drainNextBatch(ctx.context);
      expect(ctx.context.get().some((message) => message.origin?.kind === 'task')).toBe(false);
      expect(ctx.allEvents.some((event) => event.event === 'task.notified')).toBe(false);
      expect(ctx.llmCalls).toHaveLength(0);
      expect(
        records.findLast((record) => record.event === 'wait_for_completed')?.properties,
      ).toMatchObject({ outcome: 'completed', has_task_id: true, extra_completed_count: 0 });
    } finally {
      await ctx.dispose();
    }
  });

  it('does not include tasks registered after the wait started', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('WaitFor');
      expect(tool).toBeDefined();

      const slow = controllableProcess();
      const taskA = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 30', 'slow'));
      const pending = executeTool(tool!, context('wait_race', { timeout: 30 }));

      const late = controllableProcess();
      const taskB = tasks.registerTask(new ProcessTask(late.proc, 'echo b', 'late comer'));
      await tasks.suppressTerminalNotification(taskB);
      late.pushOutput('B-OUT\n');
      late.resolveWait(0);
      await waitForTerminal(tasks, taskB);

      const race = await Promise.race([
        pending.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ]);
      expect(race).toBe('pending');

      slow.pushOutput('A-OUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskA}`);
      expect(output).not.toContain(taskB);
      expect(output).not.toContain('[completed_during_wait]');
      expect(ctx.allEvents.filter((event) => event.event === 'task.waitDelivered')).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  });

  it('returns from a wait on a task that never settles once the timeout elapses', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IWaitForTool);
      const taskId = tasks.registerTask(
        new SubagentTask(
          {
            agentId: 'agent-hang',
            profileName: 'coder',
            completion: new Promise<{ result: string }>(() => {}),
          },
          'hung work',
          new AbortController(),
        ),
      );

      const result = await executeTool(tool, context('wait_hang', { timeout: 1, task_id: taskId }));
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: timed_out');
      expect(output).toContain('[still_running]');
      expect(output).toContain(taskId);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('AgentResultTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new AgentResultTool(new FakeTaskService(), stubFlag(true));

    expect(tool.name).toBe('AgentResult');
    expect(tool.description).toContain('agent id');
    expect(AgentResultInputSchema.safeParse({ agent_id: 'agent-child' }).success).toBe(true);
    expect(AgentResultInputSchema.safeParse({ agent_id: '' }).success).toBe(false);
    expect(AgentResultInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    });
  });

  it('resolves execution metadata and matches the agent id', () => {
    const tool = new AgentResultTool(new FakeTaskService(), stubFlag(true));

    const execution = tool.resolveExecution({ agent_id: 'agent-child' }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;

    expect(execution.description).toBe('Reading result of agent agent-child');
    expect(execution.accesses).toEqual([]);
    expect(execution.approvalRule).toBe('AgentResult');
    expect(execution.matchesRule?.('agent-*')).toBe(true);
    expect(execution.matchesRule?.('other-agent')).toBe(false);
  });

  it('returns the agent result snapshot with the preview', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      agentTaskInfo(),
      outputSnapshot('SUBAGENT-ANSWER\n', {
        outputPath: '/tmp/session/tasks/agent-abc12345/output.log',
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(true)),
      context('agent_result_ok', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('retrieval_status: success');
    expect(output).toContain('agent_id: agent-child');
    expect(output).toContain('status: completed');
    expect(output).toContain('output_path: /tmp/session/tasks/agent-abc12345/output.log');
    expect(output).toContain('output_size_bytes: 16');
    expect(output).toContain('[output]\nSUBAGENT-ANSWER');
    expect(output).not.toContain('[Truncated.');
  });

  it('prefers the running task over an older finished task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      agentTaskInfo({
        taskId: 'agent-old00001',
        status: 'completed',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
      }),
      outputSnapshot('OLD-RESULT\n'),
    );
    tasks.add(
      agentTaskInfo({
        taskId: 'agent-live0001',
        status: 'running',
        startedAt: 1_700_000_002_000,
        endedAt: null,
      }),
      outputSnapshot('LIVE-RESULT\n', { outputPath: '/tmp/live.log', fullOutputAvailable: true }),
    );

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(true)),
      context('agent_result_running', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('retrieval_status: not_ready');
    expect(output).toContain('task_id: agent-live0001');
    expect(output).toContain('[output]\nLIVE-RESULT');
    expect(output).not.toContain('OLD-RESULT');
  });

  it('reports an empty preview', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ status: 'running', endedAt: null }));

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(true)),
      context('agent_result_empty', { agent_id: 'agent-child' }),
    );

    expect(outputString(result)).toContain('[output]\n[no output available]');
  });

  it.each([
    {
      label: 'a persisted full log',
      snapshot: outputSnapshot('TAIL\n', {
        outputPath: '/tmp/full.log',
        truncated: true,
        fullOutputAvailable: true,
      }),
      banner: '[Truncated. Full output: /tmp/full.log]',
    },
    {
      label: 'no persisted full log',
      snapshot: outputSnapshot('TAIL\n', { truncated: true }),
      banner: '[Truncated. Full output: unavailable]',
    },
  ])('points at the full output when truncated with $label', async ({ snapshot, banner }) => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo(), snapshot);

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(true)),
      context('agent_result_truncated', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('output_truncated: true');
    expect(output).toContain(banner);
  });

  it('returns an error for an unknown agent', async () => {
    const result = await executeTool(
      new AgentResultTool(new FakeTaskService(), stubFlag(true)),
      context('agent_result_unknown', { agent_id: 'agent-missing' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toBe('No task found for agent: agent-missing');
  });

  it('rejects execution when the agent_messaging flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo());

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(false)),
      context('agent_result_flag_off', { agent_id: 'agent-child' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('agent_messaging experimental flag is off');
  });

  it('succeeds when the agent_messaging flag is on', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo(), outputSnapshot('FLAG-ON\n'));

    const result = await executeTool(
      new AgentResultTool(tasks, stubFlag(true)),
      context('agent_result_flag_on', { agent_id: 'agent-child' }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('FLAG-ON');
  });
});

describe('AgentHealthTool', () => {
  type LoopState = 'idle' | 'running';

  function tokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
    return {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
      ...overrides,
    };
  }

  function agentHandle(options: {
    readonly loopState?: LoopState;
    readonly activity?: AgentActivityState;
  } = {}): IAgentScopeHandle {
    const agentId = 'agent-child';
    const scope = makeAgentScopeContext({ agentId, agentScope: agentId });
    const services = new Map<unknown, unknown>([
      [IAgentLoopService, { status: vi.fn(() => ({ state: options.loopState ?? 'idle' })) }],
      [IAgentActivityView, { state: vi.fn(() => options.activity ?? { lifecycle: 'ready' }) }],
      [IAgentScopeContext, scope],
    ]);
    return {
      id: agentId,
      kind: 'agent',
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => services.get(id) as T,
      },
      dispose: vi.fn(),
    };
  }

  function makeHealthTool(options: {
    readonly tasks?: FakeTaskService;
    readonly handle?: boolean;
    readonly loopState?: LoopState;
    readonly activity?: AgentActivityState;
    readonly usageStatus?: UsageStatus;
    readonly flagsOn?: boolean;
  } = {}) {
    const tasks = options.tasks ?? new FakeTaskService();
    const handleOf = vi.fn(() =>
      options.handle === false
        ? undefined
        : agentHandle({ loopState: options.loopState, activity: options.activity }),
    );
    const status = vi.fn(() => options.usageStatus ?? { total: tokenUsage() });
    const statusSize = vi.fn(() => 1234);
    const agents = { _serviceBrand: undefined, handleOf } as unknown as IAgentLifecycleService;
    const usage = { _serviceBrand: undefined, status } as unknown as ISessionUsageService;
    const tokenCounting = {
      _serviceBrand: undefined,
      statusSize,
    } as unknown as ISessionTokenCountingService;
    const tool = new AgentHealthTool(
      tasks,
      agents,
      usage,
      tokenCounting,
      stubFlag(options.flagsOn ?? true),
    );
    return { tool, tasks, handleOf, status, statusSize };
  }

  it('has name and accepts the current schema', () => {
    const { tool } = makeHealthTool();

    expect(tool.name).toBe('AgentHealth');
    expect(tool.description).toContain('health');
    expect(AgentHealthInputSchema.safeParse({ agent_id: 'agent-child' }).success).toBe(true);
    expect(AgentHealthInputSchema.safeParse({ agent_id: '' }).success).toBe(false);
    expect(AgentHealthInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    });
  });

  it('resolves execution metadata and matches the agent id', () => {
    const { tool } = makeHealthTool();

    const execution = tool.resolveExecution({ agent_id: 'agent-child' }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;

    expect(execution.description).toBe('Inspecting health of agent agent-child');
    expect(execution.accesses).toEqual([]);
    expect(execution.approvalRule).toBe('AgentHealth');
    expect(execution.matchesRule?.('agent-*')).toBe(true);
    expect(execution.matchesRule?.('other-agent')).toBe(false);
  });

  it('reports idle for a live agent with no task', async () => {
    const { tool, status, statusSize } = makeHealthTool();

    const result = await executeTool(
      tool,
      context('agent_health_idle', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('state: idle');
    expect(output).toContain('loop_state: idle');
    expect(output).not.toContain('task_id:');
    expect(output).toContain('context_tokens: 1234');
    expect(output).toContain('total_input_tokens: 80');
    expect(output).toContain('total_output_tokens: 20');
    expect(output).not.toContain('turn_phase:');
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-child' }));
    expect(statusSize).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-child' }));
  });

  it('reports running when the loop is running', async () => {
    const result = await executeTool(
      makeHealthTool({ loopState: 'running' }).tool,
      context('agent_health_running', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('state: running');
    expect(output).toContain('loop_state: running');
  });

  it('reports stalled when a running agent task exists but the loop is idle', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ status: 'running', endedAt: null }));

    const result = await executeTool(
      makeHealthTool({ tasks }).tool,
      context('agent_health_stalled', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('state: stalled');
    expect(output).toContain('task_id: agent-abc12345');
    expect(output).toContain('task_status: running');
    expect(output).toContain('task_kind: agent');
    expect(output).toContain('task_started_at: 1700000000000');
  });

  it('reports orphaned when the agent has no live handle', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ status: 'running', endedAt: null }));

    const result = await executeTool(
      makeHealthTool({ tasks, handle: false }).tool,
      context('agent_health_orphaned', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('state: orphaned');
    expect(output).toContain('task_id: agent-abc12345');
    expect(output).not.toContain('loop_state:');
    expect(output).not.toContain('context_tokens:');
  });

  it('reports lost for a lost task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ status: 'lost' }));

    const result = await executeTool(
      makeHealthTool({ tasks }).tool,
      context('agent_health_lost', { agent_id: 'agent-child' }),
    );

    expect(outputString(result)).toContain('state: lost');
  });

  it('reports completed for a completed task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo());

    const result = await executeTool(
      makeHealthTool({ tasks }).tool,
      context('agent_health_completed', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('state: completed');
    expect(output).toContain('task_status: completed');
    expect(output).toContain('task_ended_at: 1700000001000');
  });

  it('includes turn activity and background capacity', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ status: 'running', endedAt: null }));
    tasks.capacityOverride = { running: 1, max: 3 };
    const activity: AgentActivityState = {
      lifecycle: 'ready',
      turn: {
        turnId: 3,
        origin: { kind: 'user' },
        phase: 'tool_call',
        step: 2,
        ending: false,
        pendingApprovals: [{ approvalId: 'approval-1', since: 1 }],
        activeToolCalls: [
          { toolCallId: 'toolcall-1', name: 'Bash', since: 1 },
          { toolCallId: 'toolcall-2', name: 'Read', since: 2 },
        ],
        since: 1,
      },
      lastTurn: { turnId: 2, reason: 'completed', at: 1 },
      background: [],
    };

    const result = await executeTool(
      makeHealthTool({ tasks, loopState: 'running', activity }).tool,
      context('agent_health_activity', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('turn_phase: tool_call');
    expect(output).toContain('turn_step: 2');
    expect(output).toContain('active_tools: Bash, Read');
    expect(output).toContain('pending_approvals: 1');
    expect(output).toContain('last_turn_reason: completed');
    expect(output).toContain('background_capacity: 1/3');
  });

  it('omits active tools when no tool call is running', async () => {
    const activity: AgentActivityState = {
      lifecycle: 'ready',
      turn: {
        turnId: 1,
        origin: { kind: 'user' },
        phase: 'running',
        step: 1,
        ending: false,
        pendingApprovals: [],
        activeToolCalls: [],
        since: 1,
      },
      background: [],
    };

    const result = await executeTool(
      makeHealthTool({ activity, loopState: 'running' }).tool,
      context('agent_health_no_tools', { agent_id: 'agent-child' }),
    );

    expect(outputString(result)).not.toContain('active_tools:');
  });

  it('omits token totals when no usage is recorded', async () => {
    const result = await executeTool(
      makeHealthTool({ usageStatus: {} }).tool,
      context('agent_health_no_usage', { agent_id: 'agent-child' }),
    );
    const output = outputString(result);

    expect(output).toContain('context_tokens: 1234');
    expect(output).not.toContain('total_input_tokens:');
    expect(output).not.toContain('total_output_tokens:');
  });

  it('returns an error when neither a handle nor a task exists', async () => {
    const result = await executeTool(
      makeHealthTool({ handle: false }).tool,
      context('agent_health_missing', { agent_id: 'agent-child' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toBe('Agent not found: agent-child');
  });

  it('rejects execution when the agent_messaging flag is off', async () => {
    const result = await executeTool(
      makeHealthTool({ flagsOn: false }).tool,
      context('agent_health_flag_off', { agent_id: 'agent-child' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('agent_messaging experimental flag is off');
  });
});

describe('WaitForAllTool', () => {
  it('has name and enforces the schema boundaries', () => {
    const tool = new WaitForAllTool(new FakeTaskService(), stubFlag(true));

    expect(tool.name).toBe('WaitForAll');
    expect(tool.description).toContain('cohort');
    expect(WaitForAllInputSchema.safeParse({ timeout: 60 }).success).toBe(true);
    expect(
      WaitForAllInputSchema.safeParse({ timeout: 60, agent_ids: ['agent-a'] }).success,
    ).toBe(true);
    expect(
      WaitForAllInputSchema.safeParse({ timeout: 60, task_ids: ['bash-a'] }).success,
    ).toBe(true);
    expect(
      WaitForAllInputSchema.safeParse({
        timeout: 60,
        agent_ids: ['agent-a'],
        task_ids: ['bash-a'],
      }).success,
    ).toBe(false);
    expect(WaitForAllInputSchema.safeParse({}).success).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: -5 }).success).toBe(false);
    expect(
      WaitForAllInputSchema.safeParse({ timeout: WAIT_FOR_ALL_MAX_TIMEOUT_S }).success,
    ).toBe(true);
    expect(
      WaitForAllInputSchema.safeParse({ timeout: WAIT_FOR_ALL_MAX_TIMEOUT_S + 1 }).success,
    ).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: 1.5 }).success).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: 60, agent_ids: [] }).success).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: 60, task_ids: [] }).success).toBe(false);
    expect(WaitForAllInputSchema.safeParse({ timeout: 60, task_ids: [''] }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['timeout'],
      properties: {
        timeout: { type: 'integer' },
        agent_ids: { type: 'array' },
        task_ids: { type: 'array' },
      },
    });
  });

  it.each<{ readonly args: WaitForAllInput; readonly expected: string }>([
    {
      args: { timeout: 10, task_ids: ['bash-a', 'bash-b'] },
      expected: 'Waiting up to 10s for 2 tasks',
    },
    {
      args: { timeout: 10, agent_ids: ['agent-a'] },
      expected: 'Waiting up to 10s for 1 agent',
    },
    {
      args: { timeout: 10, agent_ids: ['agent-a', 'agent-b'] },
      expected: 'Waiting up to 10s for 2 agents',
    },
    { args: { timeout: 10 }, expected: 'Waiting up to 10s for all background tasks' },
  ])('describes the cohort as $expected', ({ args, expected }) => {
    const tool = new WaitForAllTool(new FakeTaskService(), stubFlag(true));

    const execution = tool.resolveExecution(args) as Extract<
      ToolExecution,
      { execute: unknown }
    >;

    expect(execution.description).toBe(expected);
    expect(execution.accesses).toEqual([]);
    expect(execution.approvalRule).toBe('WaitForAll');
  });

  it('matches the unfiltered cohort subject', () => {
    const tool = new WaitForAllTool(new FakeTaskService(), stubFlag(true));

    const execution = tool.resolveExecution({ timeout: 10 }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;

    expect(execution.matchesRule?.('all')).toBe(true);
    expect(execution.matchesRule?.('other')).toBe(false);
  });

  it('waits on every running task with a bounded shared timeout', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-many1' }));
    tasks.add(processTask({ taskId: 'bash-wa-many2' }));
    tasks.waitDelegate = async (taskId) => {
      tasks.settle(taskId);
      return tasks.getTask(taskId);
    };

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_many', { timeout: 600 }),
    );

    expect(result.isError).toBe(false);
    expect(tasks.waitCalls.map((call) => call.taskId)).toEqual([
      'bash-wa-many1',
      'bash-wa-many2',
    ]);
    expect(
      tasks.waitCalls.every(
        (call) =>
          call.timeoutMs !== undefined && call.timeoutMs > 0 && call.timeoutMs <= 600_000,
      ),
    ).toBe(true);
  });

  it('reports completed and marks every finished task delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-done1' }));
    tasks.add(processTask({ taskId: 'bash-wa-done2' }));
    tasks.capacityOverride = { running: 1, max: 3 };
    tasks.waitDelegate = async (taskId) => {
      tasks.settle(taskId);
      return tasks.getTask(taskId);
    };

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_completed', { timeout: 600 }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('cohort_count: 2');
    expect(output).toContain('finished_count: 2');
    expect(output).toContain('background_capacity: 1/3');
    expect(output).toContain('[finished]');
    expect(output).toContain('task_id: bash-wa-done1');
    expect(output).not.toMatch(/^agent_id:/m);
    expect(output).toContain('Use AgentResult with the agent_id or TaskOutput with the task_id');
    expect(output).not.toContain('[still_running]');
    expect(tasks.waitDeliveries).toEqual([
      [
        { taskId: 'bash-wa-done1', status: 'completed' },
        { taskId: 'bash-wa-done2', status: 'completed' },
      ],
    ]);
  });

  it('reports partial and marks only the finished tasks delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-fin1' }));
    tasks.add(processTask({ taskId: 'bash-wa-run1', description: 'still going' }));
    tasks.waitDelegate = async (taskId) => {
      if (taskId === 'bash-wa-fin1') tasks.settle(taskId);
      return tasks.getTask(taskId);
    };

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_partial', { timeout: 600 }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('wait_status: partial');
    expect(output).toContain('finished_count: 1');
    expect(output).toContain('[finished]');
    expect(output).toContain('[still_running]');
    expect(output).toContain('bash-wa-run1');
    expect(tasks.waitDeliveries).toEqual([[{ taskId: 'bash-wa-fin1', status: 'completed' }]]);
  });

  it('reports timed_out without marking anything delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-time1' }));

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_timeout', { timeout: 10, task_ids: ['bash-wa-time1'] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('wait_status: timed_out');
    expect(output).toContain('finished_count: 0');
    expect(output).toContain('[still_running]');
    expect(output).not.toContain('[finished]');
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('resolves an agent cohort and reports the agent id for finished tasks', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({ taskId: 'agent-cohort1', agentId: 'agent-a' }));
    tasks.add(agentTaskInfo({ taskId: 'agent-cohort2', agentId: 'agent-b' }));
    tasks.waitDelegate = async (taskId) => {
      tasks.settle(taskId);
      return tasks.getTask(taskId);
    };

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_agents', { timeout: 60, agent_ids: ['agent-a'] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('task_id: agent-cohort1');
    expect(output).toContain('agent_id: agent-a');
    expect(output).not.toContain('agent-cohort2');
    expect(tasks.waitCalls.map((call) => call.taskId)).toEqual(['agent-cohort1']);
  });

  it.each([
    { args: { timeout: 10, task_ids: ['bash-missing'] }, message: 'Task not found: bash-missing' },
    { args: { timeout: 10, agent_ids: ['agent-missing'] }, message: 'Agent not found: agent-missing' },
  ])('returns an error for an unknown cohort member ($message)', async ({ args, message }) => {
    const tasks = new FakeTaskService();

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_unknown', args),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toBe(message);
    expect(tasks.waitCalls).toEqual([]);
  });

  it('returns no_tasks without waiting when nothing is running', async () => {
    const tasks = new FakeTaskService();

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_none', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('wait_status: no_tasks');
    expect(output).toContain('waited_ms: 0');
    expect(output).toContain('timeout_ms: 10000');
    expect(output).toContain('No background tasks are running');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('rejects execution when the wait_for flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-flag1' }));

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag((id) => id === AGENT_MESSAGING_FLAG_ID)),
      context('wait_all_flag_wait_for', { timeout: 10 }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('wait_for experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('rejects execution when the agent_messaging flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-flag2' }));

    const result = await executeTool(
      new WaitForAllTool(tasks, stubFlag((id) => id === WAIT_FOR_FLAG_ID)),
      context('wait_all_flag_messaging', { timeout: 10 }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('agent_messaging experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('propagates an abort while waiting', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wa-abort' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<AgentTaskInfo | undefined>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => {
          reject(abortError());
        }, { once: true });
      });

    const controller = new AbortController();
    const pending = executeTool(
      new WaitForAllTool(tasks, stubFlag(true)),
      context('wait_all_abort', { timeout: 600 }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.waitDeliveries).toEqual([]);
  });
});

describe('StopAgentsTool', () => {
  it('stopAgentsTool_schema_requiresExactlyOneSelector', () => {
    const tool = new StopAgentsTool(new FakeTaskService(), stubFlag(true));

    expect(tool.name).toBe('StopAgents');
    expect(tool.description).toContain('background tasks');
    expect(StopAgentsInputSchema.safeParse({ task_ids: ['bash-a'] }).success).toBe(true);
    expect(StopAgentsInputSchema.safeParse({ agent_ids: ['agent-a'] }).success).toBe(true);
    expect(StopAgentsInputSchema.safeParse({ all: true }).success).toBe(true);
    expect(
      StopAgentsInputSchema.safeParse({
        task_ids: ['bash-a'],
        reason: 'cleanup',
        include_foreground: true,
      }).success,
    ).toBe(true);
    expect(StopAgentsInputSchema.safeParse({}).success).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ reason: 'cleanup' }).success).toBe(false);
    expect(
      StopAgentsInputSchema.safeParse({ task_ids: ['bash-a'], agent_ids: ['agent-a'] }).success,
    ).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ all: true, agent_ids: ['agent-a'] }).success).toBe(
      false,
    );
    expect(StopAgentsInputSchema.safeParse({ all: true, task_ids: ['bash-a'] }).success).toBe(
      false,
    );
    expect(
      StopAgentsInputSchema.safeParse({
        all: true,
        agent_ids: ['agent-a'],
        task_ids: ['bash-a'],
      }).success,
    ).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ all: false }).success).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ task_ids: [] }).success).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ agent_ids: [] }).success).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ task_ids: [''] }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        agent_ids: { type: 'array' },
        task_ids: { type: 'array' },
        all: { type: 'boolean' },
        include_foreground: { type: 'boolean' },
        reason: { type: 'string' },
      },
    });
  });

  it.each<{
    readonly label: string;
    readonly args: StopAgentsInput;
    readonly expected: string;
    readonly subject: string;
  }>([
    {
      label: 'OneTaskId',
      args: { task_ids: ['bash-a'] },
      expected: 'Stopping 1 task',
      subject: 'bash-a',
    },
    {
      label: 'ManyTaskIds',
      args: { task_ids: ['bash-a', 'bash-b'] },
      expected: 'Stopping 2 tasks',
      subject: 'bash-a,bash-b',
    },
    {
      label: 'OneAgentId',
      args: { agent_ids: ['agent-a'] },
      expected: 'Stopping 1 agent',
      subject: 'agent-a',
    },
    {
      label: 'ManyAgentIds',
      args: { agent_ids: ['agent-a', 'agent-b'] },
      expected: 'Stopping 2 agents',
      subject: 'agent-a,agent-b',
    },
    {
      label: 'All',
      args: { all: true },
      expected: 'Stopping all background tasks',
      subject: 'all',
    },
  ])('stopAgentsTool_resolveExecution_setsMetadataFor$label', ({ args, expected, subject }) => {
    const tool = new StopAgentsTool(new FakeTaskService(), stubFlag(true));

    const execution = tool.resolveExecution(args) as Extract<ToolExecution, { execute: unknown }>;

    expect(execution.description).toBe(expected);
    expect(execution.accesses).toEqual([]);
    expect(execution.approvalRule).toBe('StopAgents');
    expect(execution.matchesRule?.(subject)).toBe(true);
    expect(execution.matchesRule?.('unrelated')).toBe(false);
  });

  it('stopAgentsTool_taskIds_stopsRunningDetachedTaskAfterSuppressing', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-run0001' }));
    const order: string[] = [];
    const suppress = tasks.suppressTerminalNotification.bind(tasks);
    const stop = tasks.stop.bind(tasks);
    vi.spyOn(tasks, 'suppressTerminalNotification').mockImplementation(async (id) => {
      order.push(`suppress:${id}`);
      return suppress(id);
    });
    vi.spyOn(tasks, 'stop').mockImplementation(async (id, reason) => {
      order.push(`stop:${id}`);
      return stop(id, reason);
    });

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_task_stop', { task_ids: [taskId] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 1/1');
    expect(output).toContain(
      `task_id: ${taskId}\nkind: process\nstatus: stopped\nreason: Stopped by StopAgents`,
    );
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'Stopped by StopAgents' }]);
    expect(order).toEqual([`suppress:${taskId}`, `stop:${taskId}`]);
  });

  it('stopAgentsTool_taskIds_reportsTerminalTaskWithoutStopping', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-sa-done001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
        stopReason: 'finished cleanly',
      }),
    );

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_task_terminal', { task_ids: [taskId] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 0/1');
    expect(output).toContain(
      `task_id: ${taskId}\nkind: process\nstatus: already_terminal\nreason: finished cleanly`,
    );
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
  });

  it.each<{
    readonly label: string;
    readonly stopReason: string | undefined;
    readonly expected: string;
  }>([
    { label: 'WithStopReason', stopReason: 'killed elsewhere', expected: 'killed elsewhere' },
    { label: 'WithoutStopReason', stopReason: undefined, expected: 'Task already completed' },
    { label: 'WithBlankStopReason', stopReason: '   ', expected: 'Task already completed' },
  ])('stopAgentsTool_taskIds_reportsTerminalReason$label', async ({ stopReason, expected }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-sa-done002',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
        stopReason,
      }),
    );

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_task_terminal_reason', { task_ids: [taskId] }),
    );

    expect(outputString(result)).toContain(`status: already_terminal\nreason: ${expected}`);
  });

  it('stopAgentsTool_taskIds_reportsUnknownTaskAsNotFound', async () => {
    const tasks = new FakeTaskService();

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_task_missing', { task_ids: ['bash-sa-missing1'] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 0/1');
    expect(output).toContain('task_id: bash-sa-missing1\nstatus: not_found\nreason: Task not found');
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
  });

  it('stopAgentsTool_agentIds_resolvesLatestTaskViaAgentTaskFor', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      agentTaskInfo({
        taskId: 'agent-sa-old0001',
        agentId: 'agent-child',
        status: 'completed',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
      }),
    );
    const liveId = tasks.add(
      agentTaskInfo({
        taskId: 'agent-sa-live001',
        agentId: 'agent-child',
        status: 'running',
        startedAt: 1_700_000_002_000,
        endedAt: null,
      }),
    );

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_agent_latest', { agent_ids: ['agent-child'] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 1/1');
    expect(output).toContain(
      `task_id: ${liveId}\nagent_id: agent-child\nkind: agent\nstatus: stopped\nreason: Stopped by StopAgents`,
    );
    expect(output).not.toContain('agent-sa-old0001');
    expect(tasks.stopCalls).toEqual([{ taskId: liveId, reason: 'Stopped by StopAgents' }]);
    expect(tasks.suppressCalls).toEqual([liveId]);
  });

  it('stopAgentsTool_agentIds_reportsUnknownAgentAsNotFound', async () => {
    const tasks = new FakeTaskService();

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_agent_missing', { agent_ids: ['agent-missing'] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 0/1');
    expect(output).toContain(
      'agent_id: agent-missing\nstatus: not_found\nreason: No task found for agent',
    );
    expect(tasks.stopCalls).toEqual([]);
  });

  it('stopAgentsTool_foreground_skipsByDefault', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-fg00001', detached: false }));

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_foreground_default', { task_ids: [taskId] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 0/1');
    expect(output).toContain(
      `task_id: ${taskId}\nkind: process\nstatus: skipped_foreground\nreason: Foreground task skipped; set include_foreground=true to stop it.`,
    );
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
  });

  it('stopAgentsTool_foreground_stopsWhenIncludeForegroundIsTrue', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-fg00002', detached: false }));

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_foreground_included', {
        task_ids: [taskId],
        include_foreground: true,
      }),
    );

    expect(result.isError).toBe(false);
    expect(outputString(result)).toContain('stop_status: 1/1');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'Stopped by StopAgents' }]);
    expect(tasks.suppressCalls).toEqual([taskId]);
  });

  it('stopAgentsTool_foreground_reportsTerminalForegroundTaskAsAlreadyTerminal', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-sa-fgdone1',
        detached: false,
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_foreground_terminal', { task_ids: [taskId] }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 0/1');
    expect(output).toContain(
      `task_id: ${taskId}\nkind: process\nstatus: already_terminal\nreason: Task already completed`,
    );
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
  });

  it('stopAgentsTool_all_stopsActiveDetachedAndSkipsForegroundAndTerminal', async () => {
    const tasks = new FakeTaskService();
    const runningId = tasks.add(processTask({ taskId: 'bash-sa-allrun1' }));
    const foregroundId = tasks.add(processTask({ taskId: 'bash-sa-allfg01', detached: false }));
    const terminalId = tasks.add(
      processTask({
        taskId: 'bash-sa-allend1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );
    tasks.capacityOverride = { running: 1, max: 3 };

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_all', { all: true }),
    );
    const output = outputString(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('stop_status: 1/2');
    expect(output).toContain('background_capacity: 1/3');
    expect(output).toContain(`task_id: ${runningId}\nkind: process\nstatus: stopped`);
    expect(output).toContain(`task_id: ${foregroundId}\nkind: process\nstatus: skipped_foreground`);
    expect(output).not.toContain(terminalId);
    expect(tasks.stopCalls).toEqual([{ taskId: runningId, reason: 'Stopped by StopAgents' }]);
    expect(tasks.suppressCalls).toEqual([runningId]);
  });

  it.each<{
    readonly label: string;
    readonly reason: string | undefined;
    readonly expected: string;
  }>([
    { label: 'Custom', reason: '  cleanup fleet  ', expected: 'cleanup fleet' },
    { label: 'Empty', reason: '', expected: 'Stopped by StopAgents' },
    { label: 'Whitespace', reason: '   ', expected: 'Stopped by StopAgents' },
    { label: 'Omitted', reason: undefined, expected: 'Stopped by StopAgents' },
  ])('stopAgentsTool_reason_applies$label', async ({ reason, expected }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-reason1' }));

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_reason', { task_ids: [taskId], reason }),
    );

    expect(result.isError).toBe(false);
    expect(outputString(result)).toContain(`reason: ${expected}`);
    expect(tasks.stopCalls).toEqual([{ taskId, reason: expected }]);
  });

  it('stopAgentsTool_output_reportsBackgroundCapacity', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-cap0001' }));
    tasks.capacityOverride = { running: 2 };

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag(true)),
      context('stop_agents_capacity', { task_ids: [taskId] }),
    );

    expect(outputString(result)).toContain('background_capacity: 2/unlimited');
  });

  it('stopAgentsTool_flagOff_returnsDisabledMessageWithoutStopping', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-sa-flag001' }));

    const result = await executeTool(
      new StopAgentsTool(tasks, stubFlag((id) => id !== AGENT_FLEET_CONTROL_FLAG_ID)),
      context('stop_agents_flag_off', { task_ids: [taskId] }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toBe(
      'StopAgents is disabled: the agent_fleet_control experimental flag is off.',
    );
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
  });
});
