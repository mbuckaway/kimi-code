import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { TurnEnded } from '#/agent/loop/turnOps';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSupermoonService } from '#/agent/supermoon/supermoon';
import { AgentSupermoonService } from '#/agent/supermoon/supermoonService';
import { supermoonKey } from '#/agent/supermoon/supermoonOps';
import { type Event2 } from '#/app/event/event2';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';
import { lifecycleWithReminder } from '../../features/reminder/stubs';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  noopLogger,
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const ENTER_REMINDER_PATH = new URL(
  '../../../src/agent/supermoon/enter-reminder.md',
  import.meta.url,
);
const EXIT_REMINDER_PATH = new URL(
  '../../../src/agent/supermoon/exit-reminder.md',
  import.meta.url,
);

function reminderRuntime(ix: TestInstantiationService): ReminderRuntime {
  const runtime = {
    get: (id: unknown) =>
      id === IAgentContextMemoryService ? ix.get(IAgentContextMemoryService) : undefined,
  } as unknown as AgentRuntimeContext<null>;
  return new ReminderRuntime(runtime);
}

describe('AgentSupermoonService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(ISessionTokenCountingService, {
      estimateText: () => 0,
      estimateMessage: () => 0,
      estimateMessages: () => 0,
      recordTruncation: () => {},
    } as unknown as ISessionTokenCountingService);
    ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix, testWireScope('wire', 'supermoon-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
      logger: noopLogger,
      telemetry: noopTelemetryService,
    });
    registerTestEventDispatcher(ix);
    ix.stub(IAgentLifecycleService, lifecycleWithReminder(reminderRuntime(ix)));
    ix.set(IAgentSupermoonService, new SyncDescriptor(AgentSupermoonService));
  });
  afterEach(() => disposables.dispose());

  function publishTurnEnded(): void {
    const bus = ix.get(IEventBus) as ISessionEventBus;
    bus.publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const events: Event2[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(supermoon.isActive).toBe(false);
    supermoon.enter('manual');
    expect(supermoon.isActive).toBe(true);
    supermoon.exit();
    expect(supermoon.isActive).toBe(false);

    expect(events).toEqual([
      {
        type: 'agent.status.updated',
        agentId: 'test-agent',
        supermoonMode: true,
        time: expect.any(Number),
      },
      {
        type: 'context.spliced',
        agentId: 'test-agent',
        start: 0,
        deleteCount: 0,
        messages: [
          expect.objectContaining({
            origin: { kind: 'injection', variant: 'supermoon_mode' },
          }),
        ],
        time: expect.any(Number),
      },
      {
        type: 'agent.status.updated',
        agentId: 'test-agent',
        supermoonMode: false,
        time: expect.any(Number),
      },
      {
        type: 'context.spliced',
        agentId: 'test-agent',
        start: 0,
        deleteCount: 1,
        messages: [],
        time: expect.any(Number),
      },
    ]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger (silent)', async () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'supermoon-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      {
        type: 'supermoon_mode.enter',
        agentId: 'test-agent',
        trigger: 'manual',
        time: expect.any(Number),
      },
      {
        type: 'context.append_message',
        agentId: 'test-agent',
        message: expect.objectContaining({
          origin: { kind: 'injection', variant: 'supermoon_mode' },
        }),
        time: expect.any(Number),
      },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'supermoon-replay'), {
      log: ix2.get(IAppendLogStore),
      logger: noopLogger,
      telemetry: noopTelemetryService,
    });
    const fresh = registerTestEventDispatcher(ix2);
    const freshState = ix2.get(IAgentStateService);
    freshState.contributeState(supermoonKey);
    await restoreTestEventDispatcher(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'supermoon-replay'),
      records.filter((record) => record.type === 'supermoon_mode.enter'),
    );
    expect(freshState.get(supermoonKey)).toBe('manual');
  });

  it('enter appends the enter reminder for both manual and task triggers', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService);

    supermoon.enter('manual');
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]).toMatchObject({
      role: 'user',
      origin: { kind: 'injection', variant: 'supermoon_mode' },
    });

    supermoon.exit();
    supermoon.enter('task');
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]).toMatchObject({
      origin: { kind: 'injection', variant: 'supermoon_mode' },
    });
  });

  it('exit pops the enter reminder when it is the last context message', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('manual');

    const events: Event2[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));
    supermoon.exit();

    expect(events).toContainEqual({
      type: 'context.spliced',
      agentId: 'test-agent',
      start: 0,
      deleteCount: 1,
      messages: [],
      time: expect.any(Number),
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'context.spliced', deleteCount: 0 }),
    );
  });

  it('exit appends the exit reminder when the enter reminder is not the last message', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService);
    supermoon.enter('manual');
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'later message' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    supermoon.exit();

    expect(context.get()).toHaveLength(3);
    expect(context.get()[2]).toMatchObject({
      origin: { kind: 'injection', variant: 'supermoon_mode_exit' },
    });
  });

  it('auto-exits on turn.ended when the trigger is task', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('task');
    expect(supermoon.isActive).toBe(true);

    publishTurnEnded();

    expect(supermoon.isActive).toBe(false);
  });

  it('keeps manual active across turn.ended', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('manual');

    publishTurnEnded();

    expect(supermoon.isActive).toBe(true);
  });

  it('keeps tool trigger active across turn.ended', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('tool');

    publishTurnEnded();

    expect(supermoon.isActive).toBe(true);
  });

  it('exits cleanly on explicit exit when entered with the tool trigger', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('tool');
    supermoon.exit();

    expect(supermoon.isActive).toBe(false);
  });

  it('is a no-op when entering while already active', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService);
    supermoon.enter('task');

    supermoon.enter('manual');

    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]).toMatchObject({
      origin: { kind: 'injection', variant: 'supermoon_mode' },
    });
  });
});

describe('supermoon reminder markdown', () => {
  const forbiddenTokens = ['ultracode', 'claude', 'anthropic', 'workflow'] as const;
  const reminderFiles = [
    ['enter-reminder.md', ENTER_REMINDER_PATH],
    ['exit-reminder.md', EXIT_REMINDER_PATH],
  ] as const;

  it.each(reminderFiles)('%s contains none of the forbidden tokens', (name, file) => {
    const content = readFileSync(file, 'utf-8').toLowerCase();
    for (const token of forbiddenTokens) {
      expect(content, `"${name}" must not contain "${token}"`).not.toContain(token);
    }
  });
});
