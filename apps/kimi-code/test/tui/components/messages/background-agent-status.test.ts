import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import { BRAILLE_SPINNER_FRAMES, MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { SubagentActivityStore } from '#/tui/controllers/subagent-activity-store';
import type { BackgroundAgentStatusData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const START_MS = 1_700_000_000_000;
const LIVE_ACTIVITY_MAX_CHARS = 160;

function startedData(): BackgroundAgentStatusData {
  return {
    phase: 'started',
    headline: 'explore agent started in background',
    detail: 'Explore project structure',
    agentId: 'agent-1',
    startedAtMs: START_MS,
  };
}

function stepStartedEvent(agentId: string, step: number): Event {
  return {
    sessionId: 's1',
    agentId,
    type: 'turn.step.started',
    turnId: 1,
    step,
  } as unknown as Event;
}

function toolStartedEvent(agentId: string, name: string): Event {
  return {
    sessionId: 's1',
    agentId,
    type: 'tool.call.started',
    turnId: 1,
    step: 0,
    toolCallId: `${name}-1`,
    name,
    args: {},
  } as unknown as Event;
}

function toolResultEvent(agentId: string, name: string): Event {
  return {
    sessionId: 's1',
    agentId,
    type: 'tool.result',
    turnId: 1,
    step: 0,
    toolCallId: `${name}-1`,
    output: 'ok',
    isError: false,
  } as unknown as Event;
}

function assistantDeltaEvent(agentId: string, delta: string): Event {
  return {
    sessionId: 's1',
    agentId,
    type: 'assistant.delta',
    turnId: 1,
    step: 0,
    delta,
  } as unknown as Event;
}

function makeActivityStore(): SubagentActivityStore {
  const store = new SubagentActivityStore();
  store.ensureRecord({
    agentId: 'agent-1',
    agentName: 'explore',
    parentToolCallId: 'tc-agent-1',
  });
  store.applyEvent(stepStartedEvent('agent-1', 0));
  return store;
}

function renderLines(component: BackgroundAgentStatusComponent, width = 120): string[] {
  return component.render(width).map((line) => strip(line).trimEnd());
}

describe('BackgroundAgentStatusComponent', () => {
  it('renders started/completed with the shared bullet and failed with a red x marker', () => {
    const started = new BackgroundAgentStatusComponent({
      phase: 'started',
      headline: 'explore agent started in background',
      detail: 'Explore project structure',
    });
    const completed = new BackgroundAgentStatusComponent({
      phase: 'completed',
      headline: 'explore agent completed in background',
      detail: 'Explore project structure',
    });
    const failed = new BackgroundAgentStatusComponent({
      phase: 'failed',
      headline: 'explore agent failed in background',
      detail: 'Explore project structure · boom',
    });

    const startedLines = started.render(120).map((line) => strip(line).trimEnd());
    const completedLines = completed.render(120).map((line) => strip(line).trimEnd());
    const failedLines = failed.render(120).map((line) => strip(line).trimEnd());

    expect(startedLines[0]).toBe('');
    expect(completedLines[0]).toBe('');
    expect(failedLines[0]).toBe('');

    expect(startedLines[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(completedLines[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (Explore project structure)`,
    );
    expect(failedLines[1]).toBe(
      '✗ explore agent failed in background (Explore project structure · boom)',
    );
  });

  it('keeps status lines within very narrow widths', () => {
    const component = new BackgroundAgentStatusComponent({
      phase: 'started',
      headline: 'explore agent started in background',
      detail: 'Explore project structure',
    });

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('BackgroundAgentStatusComponent — live background agent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a spinner, elapsed time, and the running tool while the agent works', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    store.applyEvent(toolStartedEvent('agent-1', 'Read'));
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(startedData(), store, requestRender);

    vi.advanceTimersByTime(12_000);
    const lines = renderLines(component);

    expect(lines[1]).toBe(
      `${BRAILLE_SPINNER_FRAMES[12 % BRAILLE_SPINNER_FRAMES.length]} explore agent running in background (12s)`,
    );
    expect(lines[2]).toBe(`${MESSAGE_INDENT}Using Read · 1 step`);
    expect(requestRender).toHaveBeenCalledTimes(12);
    expect(requestRender).toHaveBeenCalledWith();
  });

  it('marks the tool call as used once its result lands', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    store.applyEvent(toolStartedEvent('agent-1', 'Read'));
    store.applyEvent(toolResultEvent('agent-1', 'Read'));
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    const lines = renderLines(component);

    expect(lines[2]).toBe(`${MESSAGE_INDENT}Used Read · 1 step`);
  });

  it('formats a minute-scale elapsed label', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const component = new BackgroundAgentStatusComponent(startedData(), makeActivityStore(), vi.fn());

    vi.advanceTimersByTime(90_000);
    const lines = renderLines(component);

    expect(lines[1]).toBe(
      `${BRAILLE_SPINNER_FRAMES[90 % BRAILLE_SPINNER_FRAMES.length]} explore agent running in background (1m 30s)`,
    );
  });

  it('clamps a start time in the future to zero elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const component = new BackgroundAgentStatusComponent(
      { ...startedData(), startedAtMs: START_MS + 5_000 },
      makeActivityStore(),
      vi.fn(),
    );

    const lines = renderLines(component);

    expect(lines[1]).toBe(
      `${BRAILLE_SPINNER_FRAMES[0]} explore agent running in background (0s)`,
    );
  });

  it('falls back to the headline when it carries no started suffix', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const component = new BackgroundAgentStatusComponent(
      { ...startedData(), headline: 'explore agent' },
      makeActivityStore(),
      vi.fn(),
    );

    const lines = renderLines(component);

    expect(lines[1]).toBe(`${BRAILLE_SPINNER_FRAMES[0]} explore agent running in background (0s)`);
  });

  it('falls back to the latest assistant text when no tool call started', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    store.applyEvent(assistantDeltaEvent('agent-1', 'Reading src/a.ts\nmore files'));
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    const lines = renderLines(component);

    expect(lines[2]).toBe(`${MESSAGE_INDENT}Reading src/a.ts more files · 1 step`);
  });

  it('caps a long latest-activity line to a trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    store.applyEvent(assistantDeltaEvent('agent-1', 'x'.repeat(200)));
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    const lines = renderLines(component, 200);

    expect(lines[2]).toBe(`${MESSAGE_INDENT}…${'x'.repeat(LIVE_ACTIVITY_MAX_CHARS)} · 1 step`);
  });

  it('renders the completed state in place and stops refreshing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(startedData(), store, requestRender);
    vi.advanceTimersByTime(3_000);

    store.markCompleted('agent-1', 'Reviewed the long-running work.');
    const lines = renderLines(component);
    requestRender.mockClear();
    vi.advanceTimersByTime(5_000);

    expect(lines[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (Reviewed the long-running work.)`,
    );
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('renders the failed state with the error from the activity record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    store.markFailed('agent-1', 'boom');
    const lines = renderLines(component);

    expect(lines[1]).toBe(`${FAILURE_MARK}explore agent failed in background (boom)`);
  });

  it('keeps the spawn detail when the terminal record carries no summary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    store.markCompleted('agent-1');
    const lines = renderLines(component);

    expect(lines[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (Explore project structure)`,
    );
  });

  it('keeps the static started line when the store has no record for the agent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(
      startedData(),
      new SubagentActivityStore(),
      requestRender,
    );

    const lines = renderLines(component);
    vi.advanceTimersByTime(5_000);

    expect(lines[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('keeps the static started line when no activity store is provided', () => {
    const component = new BackgroundAgentStatusComponent(startedData());

    expect(renderLines(component)[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
  });

  it('omits the elapsed label when the start time is unknown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const component = new BackgroundAgentStatusComponent(
      { ...startedData(), startedAtMs: undefined },
      makeActivityStore(),
      vi.fn(),
    );

    const lines = renderLines(component);

    expect(lines[1]).toBe(`${BRAILLE_SPINNER_FRAMES[0]} explore agent running in background`);
  });

  it('does not refresh a non-started entry even with a live store', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(
      { phase: 'completed', headline: 'explore agent completed in background' },
      makeActivityStore(),
      requestRender,
    );

    vi.advanceTimersByTime(5_000);

    expect(renderLines(component)[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background`,
    );
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('does not refresh when the entry carries no agent id', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(
      { ...startedData(), agentId: undefined },
      makeActivityStore(),
      requestRender,
    );

    vi.advanceTimersByTime(5_000);

    expect(renderLines(component)[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('does not refresh without an activity store', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(startedData(), undefined, requestRender);

    vi.advanceTimersByTime(5_000);

    expect(renderLines(component)[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('stops refreshing once disposed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(startedData(), store, requestRender);

    component.dispose();
    vi.advanceTimersByTime(5_000);

    expect(requestRender).not.toHaveBeenCalled();
  });

  it('stops the refresh timer when the record turns terminal before the next render', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    const requestRender = vi.fn();
    const component = new BackgroundAgentStatusComponent(startedData(), store, requestRender);
    vi.advanceTimersByTime(2_000);
    requestRender.mockClear();

    store.markCompleted('agent-1', 'done');
    vi.advanceTimersByTime(5_000);

    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(renderLines(component)[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (done)`,
    );
  });

  it('unrefs the refresh timer so it cannot hold the process open', () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      { unref } as unknown as ReturnType<typeof setInterval>,
    );
    const component = new BackgroundAgentStatusComponent(
      startedData(),
      makeActivityStore(),
      vi.fn(),
    );

    component.dispose();

    expect(unref).toHaveBeenCalledWith();
  });

  it('keeps the live line within very narrow widths', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const store = makeActivityStore();
    store.applyEvent(toolStartedEvent('agent-1', 'Read'));
    const component = new BackgroundAgentStatusComponent(startedData(), store, vi.fn());

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
