import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import {
  SubAgentEventHandler,
  type SubagentLifecycleEvent,
} from '#/tui/controllers/subagent-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import type { TranscriptEntry } from '#/tui/types';

function makeStreamingUIStub() {
  return {
    getToolComponent: vi.fn(() => undefined),
    getActiveToolCall: vi.fn(() => undefined),
    onToolCallStart: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    removeToolComponentIfInactive: vi.fn(),
    applyBackgroundTaskTerminalStatus: vi.fn(),
    markSubagentBackgrounded: vi.fn(),
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    setTodoList: vi.fn(),
    resetToolUi: vi.fn(),
    finalizeTurn: vi.fn(),
  };
}

function makeSubagentHandler() {
  const backgroundTasks = new Map<string, never>();
  const transcriptEntries: TranscriptEntry[] = [];
  const host = {
    state: {
      appState: { availableModels: {} },
      ui: { requestRender: vi.fn() },
      transcriptContainer: { addChild: vi.fn() },
      transcriptEntries,
    },
    streamingUI: makeStreamingUIStub(),
    appendTranscriptEntry: vi.fn((entry: TranscriptEntry) => {
      transcriptEntries.push(entry);
    }),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    updateActivityPane: vi.fn(),
  };
  const handler = new SubAgentEventHandler(host as never, {
    backgroundTasks,
    backgroundTaskTranscriptedTerminal: new Set(),
    syncBackgroundAgentBadge: vi.fn(),
  });
  return { handler, backgroundTasks, transcriptEntries, host };
}

function spawnEvent(subagentId: string, runInBackground: boolean): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.spawned',
    subagentId,
    subagentName: 'explore',
    parentToolCallId: `tc-${subagentId}`,
    description: `task ${subagentId}`,
    runInBackground,
  } as unknown as SubagentLifecycleEvent;
}

function completedEvent(subagentId: string): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.completed',
    subagentId,
    parentToolCallId: `tc-${subagentId}`,
    resultSummary: 'done',
  } as unknown as SubagentLifecycleEvent;
}

function failedEvent(subagentId: string, error: string): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.failed',
    subagentId,
    parentToolCallId: `tc-${subagentId}`,
    error,
  } as unknown as SubagentLifecycleEvent;
}

describe('SubAgentEventHandler — activity record pruning', () => {
  it('drops the record of a foreground-only subagent at terminal state', () => {
    const { handler } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('a1', false));
    handler.activityStore.applyEvent({
      sessionId: 's1',
      agentId: 'a1',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    } as Event);
    expect(handler.activityStore.get('a1')).toBeDefined();

    handler.handleLifecycleEvent(completedEvent('a1'));

    expect(handler.activityStore.get('a1')).toBeUndefined();
  });

  it('keeps the record of a spawn-time background agent even before the task syncs', () => {
    const { handler } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('a2', true));
    handler.activityStore.applyEvent({
      sessionId: 's1',
      agentId: 'a2',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    } as Event);

    // No background.task.started has populated the task map yet.
    handler.handleLifecycleEvent(completedEvent('a2'));

    const record = handler.activityStore.get('a2');
    expect(record?.status).toBe('completed');
    expect(record?.resultSummary).toBe('done');
  });
});

function makeSessionEventHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        workDir: '/tmp/wd',
        streamingPhase: 'idle',
        availableModels: {},
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      transcriptEntries: [],
      tasksBrowser: undefined,
      footer: { setBackgroundCounts: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: makeStreamingUIStub(),
    requireSession: vi.fn(),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    refreshWireTipFromDisk: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: { repaint: vi.fn(), refreshOutputViewer: vi.fn() },
  };
  return host as never;
}

describe('SessionEventHandler — background.task.terminated', () => {
  function terminatedEvent(agentId: string, status: string): Event {
    return {
      sessionId: 's1',
      agentId: 'main',
      type: 'background.task.terminated',
      info: {
        taskId: `task-${agentId}`,
        kind: 'agent',
        agentId,
        description: 'bg task',
        status,
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event;
  }

  it('marks a still-running record failed when an agent is stopped without subagent.failed', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    handler.subAgentEventHandler.activityStore.ensureRecord({
      agentId: 'agent-9',
      agentName: 'explore',
      parentToolCallId: 'tc-9',
    });

    handler.handleEvent(terminatedEvent('agent-9', 'killed'), vi.fn());

    expect(handler.subAgentEventHandler.activityStore.get('agent-9')?.status).toBe('failed');
  });

  it('does not overwrite a record that already reached terminal state with a summary', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    const store = handler.subAgentEventHandler.activityStore;
    store.ensureRecord({ agentId: 'agent-8', agentName: 'explore', parentToolCallId: 'tc-8' });
    store.markCompleted('agent-8', 'final summary');

    handler.handleEvent(terminatedEvent('agent-8', 'completed'), vi.fn());

    const record = store.get('agent-8');
    expect(record?.status).toBe('completed');
    expect(record?.resultSummary).toBe('final summary');
  });

  it('drops foreground-only records when the main turn ends (aborted subagents emit no lifecycle event)', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    const store = handler.subAgentEventHandler.activityStore;
    store.ensureRecord({ agentId: 'agent-7', agentName: 'explore', parentToolCallId: 'tc-7' });

    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'turn.ended',
        turnId: 1,
        reason: 'cancelled',
      } as Event,
      vi.fn(),
    );

    expect(store.get('agent-7')).toBeUndefined();
  });
});

describe('SubAgentEventHandler — background agent transcript entries', () => {
  const START_MS = 1_700_000_000_000;

  it('records the agent id and start time on the started entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { handler, transcriptEntries } = makeSubagentHandler();

    handler.handleLifecycleEvent(spawnEvent('bg-1', true));
    vi.useRealTimers();

    const status = transcriptEntries[0]?.backgroundAgentStatus;
    expect(status?.phase).toBe('started');
    expect(status?.agentId).toBe('bg-1');
    expect(status?.startedAtMs).toBe(START_MS);
  });

  it('does not append a second entry when the background agent completes', () => {
    const { handler, transcriptEntries } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('bg-2', true));

    handler.handleLifecycleEvent(completedEvent('bg-2'));

    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0]?.backgroundAgentStatus?.phase).toBe('started');
    expect(handler.activityStore.get('bg-2')?.status).toBe('completed');
    expect(handler.activityStore.get('bg-2')?.resultSummary).toBe('done');
  });

  it('does not append a second entry when the background agent fails, keeping the terminal side effects', () => {
    const { handler, transcriptEntries, host } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('bg-3', true));

    handler.handleLifecycleEvent(failedEvent('bg-3', 'boom'));

    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0]?.backgroundAgentStatus?.phase).toBe('started');
    expect(handler.activityStore.get('bg-3')?.status).toBe('failed');
    expect(handler.activityStore.get('bg-3')?.error).toBe('boom');
    expect(host.streamingUI.applyBackgroundTaskTerminalStatus).toHaveBeenCalledWith({
      agentId: 'bg-3',
      description: 'task bg-3',
      status: 'failed',
      errorText: 'boom',
    });
  });

  it('appends a terminal entry when no live started entry exists for a resumed agent', () => {
    const { handler, transcriptEntries } = makeSubagentHandler();
    handler.backgroundAgentMetadata.set('bg-4', {
      agentId: 'bg-4',
      parentToolCallId: 'task-bg-4',
      description: 'resumed task',
    });

    handler.handleLifecycleEvent(completedEvent('bg-4'));

    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0]?.backgroundAgentStatus?.phase).toBe('completed');
  });
});
