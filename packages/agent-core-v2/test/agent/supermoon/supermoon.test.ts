import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentSupermoonService } from '#/agent/supermoon/supermoon';
import { AgentSupermoonService } from '#/agent/supermoon/supermoonService';
import { SupermoonModel } from '#/agent/supermoon/supermoonOps';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubContextMemory, type StubContextMemory } from '../contextMemory/stubs';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const ENTER_REMINDER_PATH = new URL(
  '../../../src/agent/supermoon/enter-reminder.md',
  import.meta.url,
);
const EXIT_REMINDER_PATH = new URL(
  '../../../src/agent/supermoon/exit-reminder.md',
  import.meta.url,
);

describe('AgentSupermoonService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    registerTestAgentWire(ix, testWireScope('wire', 'supermoon-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSupermoonService, new SyncDescriptor(AgentSupermoonService));
  });
  afterEach(() => disposables.dispose());

  function publishTurnEnded(): void {
    ix.get(IEventBus).publish({ type: 'turn.ended', turnId: 1, reason: 'completed' });
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(supermoon.isActive).toBe(false);
    supermoon.enter('manual');
    expect(supermoon.isActive).toBe(true);
    supermoon.exit();
    expect(supermoon.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', supermoonMode: true },
      { type: 'agent.status.updated', supermoonMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
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
      { type: 'supermoon_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'supermoon-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'supermoon-replay'),
      records,
    );
    expect(fresh.getModel(SupermoonModel)).toBe('manual');
  });

  it('enter appends the enter reminder for both manual and task triggers', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService) as StubContextMemory;

    supermoon.enter('manual');
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      role: 'user',
      origin: { kind: 'injection', variant: 'supermoon_mode' },
    });

    supermoon.exit();
    supermoon.enter('task');
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]).toMatchObject({
      origin: { kind: 'injection', variant: 'supermoon_mode' },
    });
  });

  it('exit pops the enter reminder when it is the last context message', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    supermoon.enter('manual');

    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));
    supermoon.exit();

    expect(events).toContainEqual({
      type: 'context.spliced',
      start: 0,
      deleteCount: 1,
      messages: [],
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'context.spliced', deleteCount: 0 }),
    );
  });

  it('exit appends the exit reminder when the enter reminder is not the last message', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService) as StubContextMemory;
    supermoon.enter('manual');
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'later message' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    supermoon.exit();

    expect(context.messages).toHaveLength(3);
    expect(context.messages[2]).toMatchObject({
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

  it('is a no-op when entering while already active', () => {
    const supermoon = ix.get(IAgentSupermoonService);
    const context = ix.get(IAgentContextMemoryService) as StubContextMemory;
    supermoon.enter('task');

    supermoon.enter('manual');

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
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
