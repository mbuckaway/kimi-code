/**
 * SupermoonMode unit tests — v2-parity semantics (deliberately not swarm's):
 * the enter reminder is appended for EVERY trigger including 'tool', and
 * only the 'task' trigger auto-exits at turn end. Mode state survives resume
 * via restoreEnter (no records/reminders/status side effects).
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { SupermoonMode, type SupermoonModeTrigger } from '../../../src/agent/supermoon';

function makeHarness(overrides: { restoring?: boolean } = {}) {
  const records: { type: string; trigger?: SupermoonModeTrigger }[] = [];
  const reminders: { text: string; kind: string; variant: string }[] = [];
  let restoring = overrides.restoring ?? false;
  let popResult = false;
  const emitStatusUpdated = vi.fn();
  const appendSystemReminder = vi.fn((text: string, meta: { kind: string; variant: string }) => {
    reminders.push({ text, ...meta });
  });
  const popMatchedMessage = vi.fn(() => popResult);
  const agent = {
    records: {
      logRecord: vi.fn((record: { type: string; trigger?: SupermoonModeTrigger }) => {
        records.push(record);
      }),
      get restoring() {
        return restoring;
      },
    },
    context: {
      appendSystemReminder,
      popMatchedMessage,
    },
    emitStatusUpdated,
  } as unknown as Agent;
  const mode = new SupermoonMode(agent);
  return {
    mode,
    records,
    reminders,
    emitStatusUpdated,
    popMatchedMessage,
    setPopResult(v: boolean) {
      popResult = v;
    },
    setRestoring(v: boolean) {
      restoring = v;
    },
  };
}

describe('SupermoonMode', () => {
  it('enter records the trigger, appends the enter reminder, and emits status', () => {
    const h = makeHarness();
    h.mode.enter('manual');

    expect(h.mode.isActive).toBe(true);
    expect(h.records).toEqual([{ type: 'supermoon_mode.enter', trigger: 'manual' }]);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]!.variant).toBe('supermoon_mode');
    expect(h.emitStatusUpdated).toHaveBeenCalledTimes(1);
  });

  it('appends the enter reminder even for the tool trigger (v2 parity)', () => {
    const h = makeHarness();
    h.mode.enter('tool');

    expect(h.mode.isActive).toBe(true);
    expect(h.records).toEqual([{ type: 'supermoon_mode.enter', trigger: 'tool' }]);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]!.variant).toBe('supermoon_mode');
  });

  it('enter while active is a no-op', () => {
    const h = makeHarness();
    h.mode.enter('manual');
    h.records.length = 0;
    h.reminders.length = 0;
    h.emitStatusUpdated.mockClear();

    h.mode.enter('task');

    expect(h.records).toHaveLength(0);
    expect(h.reminders).toHaveLength(0);
    expect(h.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it('restoreEnter restores state silently (resume path)', () => {
    const h = makeHarness();
    h.mode.restoreEnter('task');

    expect(h.mode.isActive).toBe(true);
    expect(h.records).toHaveLength(0);
    expect(h.reminders).toHaveLength(0);
    expect(h.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it('exit records, deactivates, and pops the enter reminder when it is last', () => {
    const h = makeHarness();
    h.mode.enter('manual');
    h.setPopResult(true);
    h.reminders.length = 0;

    h.mode.exit();

    expect(h.mode.isActive).toBe(false);
    expect(h.records).toEqual([
      { type: 'supermoon_mode.enter', trigger: 'manual' },
      { type: 'supermoon_mode.exit' },
    ]);
    expect(h.popMatchedMessage).toHaveBeenCalledTimes(1);
    expect(h.reminders).toHaveLength(0); // popped, not appended
  });

  it('exit appends the exit reminder when the enter reminder is not last', () => {
    const h = makeHarness();
    h.mode.enter('manual');
    h.setPopResult(false);
    h.reminders.length = 0;

    h.mode.exit();

    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]!.variant).toBe('supermoon_mode_exit');
  });

  it('exit during restore does not append the exit reminder', () => {
    const h = makeHarness({ restoring: true });
    h.mode.restoreEnter('manual');
    h.setPopResult(false);

    h.mode.exit();

    expect(h.reminders).toHaveLength(0);
  });

  it('exit while inactive is a no-op', () => {
    const h = makeHarness();
    h.mode.exit();

    expect(h.records).toHaveLength(0);
    expect(h.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it.each([
    ['task', true],
    ['manual', false],
    ['tool', false],
  ] as const)('shouldAutoExit is %s -> %s (task-only, v2 parity)', (trigger, expected) => {
    const h = makeHarness();
    h.mode.restoreEnter(trigger);
    expect(h.mode.shouldAutoExit).toBe(expected);
  });
});
