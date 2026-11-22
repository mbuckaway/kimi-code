import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import {
  SessionMetadata,
  drainSessionMetadataWrites,
} from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

import { stubSessionIndexMirror } from '../../app/sessionIndex/stubs';
import { stubLog } from '../../_base/log/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

function createFreshMetadata(ix: TestInstantiationService): SessionMetadata {
  return ix
    .createChild(new ServiceCollection([ISessionStateService, new SessionStateService()]))
    .createInstance(SessionMetadata);
}

function makeContext(): ISessionContext {
  return makeSessionContext({
    sessionId: 's1',
    workspaceId: 'wd_test',
    sessionDir: '/tmp/sessions/wd_test/s1',
    sessionScope: 'sessions/wd_test/s1',
    metaScope: META_SCOPE,
    cwd: '/tmp/sessions/wd_test/s1',
  });
}

describe('SessionMetadata', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mirror: ReturnType<typeof stubSessionIndexMirror>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    mirror = stubSessionIndexMirror();
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionContext, makeContext());
    ix.stub(ISessionIndexMirror, mirror);
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(IFileSystemStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
  });

  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

  it('creates an initial document on first read', async () => {
    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      id: 's1',
      archived: false,
      agents: {},
      custom: {},
    });
    expect((await meta.read()).createdAt).toBeGreaterThan(0);
  });

  it('update merges fields and bumps updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.update({ title: 'hello' });

    const next = await meta.read();
    expect(next.title).toBe('hello');
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('update with touchUpdatedAt:false keeps the previous updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await meta.update({ title: 'quiet' }, { touchUpdatedAt: false });

    const next = await meta.read();
    expect(next.title).toBe('quiet');
    expect(next.updatedAt).toBe(before);
  });

  it('setTitle / setArchived write through', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.setTitle('t');
    await meta.setArchived(true);
    expect(await meta.read()).toMatchObject({ title: 't', titleKind: 'custom', archived: true });
  });

  it('sets a generated title while the metadata remains uncustomized', async () => {
    const meta = ix.get(ISessionMetadata);

    await expect(meta.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(true);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it('setTitle keeps updatedAt (rename must not reorder listings)', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.setTitle('renamed');

    const next = await meta.read();
    expect(next.title).toBe('renamed');
    expect(next.updatedAt).toBe(before);
  });

  it('setArchived records archivedAt without touching updatedAt; restore clears it', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.setArchived(true);
    const archived = await meta.read();
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeGreaterThan(before);
    expect(archived.updatedAt).toBe(before);

    await meta.setArchived(false);
    const restored = await meta.read();
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.updatedAt).toBe(before);
  });

  it('registerAgent never bumps updatedAt — the agents map is structural', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.registerAgent('main', { homedir: '/tmp/h', type: 'main' });

    const next = await meta.read();
    expect(next.agents?.['main']?.homedir).toBe('/tmp/h');
    expect(next.updatedAt).toBe(before);
  });

  it('an explicit patch.updatedAt always wins (fork inherits the source recency)', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'fork', updatedAt: 1234 });

    const next = await meta.read();
    expect(next.title).toBe('fork');
    expect(next.updatedAt).toBe(1234);
  });

  it('reads a loaded document without the archived field as not-archived', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ id: 's1', archived: false });
  });

  it('mirrors a boolean archived to the read model even when the loaded document lacks the field', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.update({ title: 'x' });

    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]).toMatchObject({ id: 's1', archived: false });
  });

  it('persists the authoritative document before recording to the mirror', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const persistedAtRecord: Promise<Record<string, unknown> | undefined>[] = [];
    const baseRecord = mirror.record;
    mirror.record = (summary) => {
      persistedAtRecord.push(store.get<Record<string, unknown>>(META_SCOPE, 'state.json'));
      baseRecord(summary);
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'durable-first' });

    expect(persistedAtRecord).toHaveLength(2);
    const [atCreate, atUpdate] = await Promise.all(persistedAtRecord);
    expect(atCreate).toMatchObject({ id: 's1', archived: false });
    expect(atUpdate).toMatchObject({ title: 'durable-first' });
  });

  it('a mirror failure degrades the read model but never fails the metadata mutation', async () => {
    mirror.record = () => {
      throw new Error('mirror down');
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'still fine' });
    expect(await meta.read()).toMatchObject({ title: 'still fine' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ title: 'still fine' });
  });

  it('persists across instances', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'persisted' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ id: 's1', title: 'persisted' });
  });

  it('backfills and persists missing agents/custom maps on a pre-fix document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ agents: {}, custom: {} });

    const fresh = createFreshMetadata(ix);
    const healed = await fresh.read();
    expect(healed.agents).toEqual({});
    expect(healed.custom).toEqual({});
    expect(healed.updatedAt).toBe(1700000000000);
  });

  it('normalizes the legacy customTitle field before callers read metadata', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      customTitle: 'legacy title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });
  });

  it('trusts modern custom title state over a stale legacy customTitle', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'renamed title',
      isCustomTitle: true,
      customTitle: 'legacy custom title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
    });

    await meta.update({ archived: true });
    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
      archived: true,
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ isCustomTitle: true });
    expect(persisted).not.toHaveProperty('customTitle');
  });

  it('migrates a legacy non-custom title to replaceable title state', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'prompt title',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);

    await expect(meta.read()).resolves.toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
      isCustomTitle: false,
    });
  });

  it('honors a legacy writer custom marker over the stale titleKind it left behind', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });

    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ titleKind: 'custom', isCustomTitle: true });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });
    await expect(fresh.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(false);
  });

  it('double-writes the derived isCustomTitle marker for v1 readers', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const meta = ix.get(ISessionMetadata);

    await meta.setGeneratedTitleIfUncustomized('generated title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'generated', isCustomTitle: false },
    );

    await meta.setTitle('user title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'custom', isCustomTitle: true },
    );
  });

  it('treats regenerating the current generated title as success without a write', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const meta = ix.get(ISessionMetadata);
    await meta.setGeneratedTitleIfUncustomized('generated title');
    const set = vi.spyOn(store, 'set');

    await expect(
      meta.setGeneratedTitleIfUncustomized('generated title', { force: true }),
    ).resolves.toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not downgrade a modern titleKind on a legacy false marker', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'generated title',
      titleKind: 'generated',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it.each([
    [{ isCustomTitle: true, titleKind: 'generated' as const }, 'custom'],
    [{ isCustomTitle: true, titleKind: 'replaceable' as const }, 'custom'],
    [{ isCustomTitle: true }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'custom' as const }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'generated' as const }, 'generated'],
    [{ isCustomTitle: false }, 'replaceable'],
    [{ titleKind: 'generated' as const }, 'generated'],
    [{ customTitle: 'legacy title' }, 'custom'],
    [{}, 'replaceable'],
  ])('normalizes title state %j to titleKind %s', async (fields, expectedKind) => {
    const store = ix.get(IAtomicDocumentStore);
    const title = 'customTitle' in fields ? undefined : 'some title';
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      ...(title === undefined ? {} : { title }),
      ...fields,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect((await meta.read()).titleKind).toBe(expectedKind);
  });

  it('migrates the title state once, not on every load', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const first = ix.get(ISessionMetadata);
    await first.ready;
    const setSpy = vi.spyOn(store, 'set');
    const fresh = createFreshMetadata(ix);
    await fresh.ready;

    expect(setSpy).not.toHaveBeenCalled();
    expect((await fresh.read()).titleKind).toBe('custom');
  });

  it('keeps a queued custom title when a generated title is enqueued afterward', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let shouldBlock = true;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      if (shouldBlock) {
        shouldBlock = false;
        markWriteStarted?.();
        await writeReleased;
      }
      await set(scope, key, value);
    });

    const priorWrite = meta.update({ lastPrompt: 'hello' });
    await writeStarted;
    const rename = meta.setTitle('user title');
    const generated = meta.setGeneratedTitleIfUncustomized('generated title');
    releaseWrite?.();

    await priorWrite;
    await rename;
    await expect(generated).resolves.toBe(false);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'user title',
      titleKind: 'custom',
    });
  });

  it('leaves existing agents/custom maps untouched', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });
  });

  it('fires onDidChangeMetadata with the changed keys after update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    let fired = 0;
    let captured: { readonly changed: readonly string[] } | undefined;
    const sub = meta.onDidChangeMetadata((e) => {
      fired++;
      captured = e;
    });
    await meta.update({ title: 'x' });
    expect(fired).toBe(1);
    expect(captured).toEqual({ changed: ['title'] });
    sub.dispose();
  });

  it('preserves every concurrently registered agent', async () => {
    const meta = ix.get(ISessionMetadata);

    await Promise.all([
      meta.registerAgent('agent-0', {
        labels: { swarmItem: 'src/a.ts' },
      }),
      meta.registerAgent('agent-1', {
        labels: { swarmItem: 'src/b.ts' },
      }),
    ]);

    expect(Object.keys((await meta.read()).agents ?? {}).sort()).toEqual([
      'agent-0',
      'agent-1',
    ]);
  });

  it('coalesces concurrent agent registrations into one queued write', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');
    const agentIds = Array.from({ length: 8 }, (_, index) => `agent-${index}`);

    await Promise.all(
      agentIds.map((agentId, index) =>
        meta.registerAgent(agentId, { homedir: `/tmp/agents/${index}`, type: 'sub' }),
      ),
    );

    expect(setSpy.mock.calls.length).toBeLessThan(agentIds.length);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const persisted = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    expect(Object.keys(persisted?.agents ?? {}).toSorted()).toEqual(agentIds.toSorted());
    expect(Object.keys((await meta.read()).agents ?? {}).toSorted()).toEqual(agentIds.toSorted());
  });

  it('fires one change event per coalesced agents patch', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const events: { readonly changed: readonly string[] }[] = [];
    const sub = meta.onDidChangeMetadata((event) => {
      events.push(event);
    });

    await Promise.all([
      meta.registerAgent('agent-0', { type: 'sub' }),
      meta.registerAgent('agent-1', { type: 'sub' }),
    ]);

    expect(events).toEqual([{ changed: ['agents'] }]);
    sub.dispose();
  });

  it('coalesces a queued unregister with a register into one write', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('agent-a', { type: 'sub' });
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');

    await Promise.all([
      meta.unregisterAgent('agent-a'),
      meta.registerAgent('agent-b', { type: 'sub' }),
    ]);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const persisted = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    expect(persisted?.agents).toEqual({ 'agent-b': { type: 'sub' } });
  });

  it('keeps agent registration order around an interleaved non-agents patch', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');

    await Promise.all([
      meta.registerAgent('agent-0', { type: 'sub' }),
      meta.update({ title: 'mid' }, { touchUpdatedAt: false }),
      meta.registerAgent('agent-1', { type: 'sub' }),
    ]);

    expect(setSpy).toHaveBeenCalledTimes(3);
    const documents = setSpy.mock.calls.map((call) => call[2] as SessionMeta);
    expect(documents[0]?.agents).toEqual({ 'agent-0': { type: 'sub' } });
    expect(documents[1]).toMatchObject({ title: 'mid', agents: { 'agent-0': { type: 'sub' } } });
    expect(documents[2]?.agents).toEqual({
      'agent-0': { type: 'sub' },
      'agent-1': { type: 'sub' },
    });
  });

  it('writes once for a non-agents patch', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');

    await meta.update({ title: 'single write' });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      META_SCOPE,
      'state.json',
      expect.objectContaining({ title: 'single write' }),
    );
  });

  it('skips the write when every coalesced registration is unchanged', async () => {
    const meta = ix.get(ISessionMetadata);
    const alreadyKnown: AgentMeta = { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' };
    await meta.registerAgent('main', alreadyKnown);
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });

    await Promise.all([meta.registerAgent('main', alreadyKnown), meta.registerAgent('main', alreadyKnown)]);

    expect(setSpy).not.toHaveBeenCalled();
    expect(fired).toBe(0);
    sub.dispose();
  });

  it('treats re-registering an unchanged agent as a no-op', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect(fired).toBe(0);
    expect((await meta.read()).updatedAt).toBe(before);
    sub.dispose();
  });

  it('stays a no-op when re-registering against a persisted document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {
        main: {
          homedir: '/tmp/sessions/wd_test/s1/agents/main',
          type: 'main',
          parentAgentId: null,
        },
      },
    });

    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect((await meta.read()).updatedAt).toBe(1700000000000);
  });

  it('updates changed fields on re-registration without bumping updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
    });
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      labels: { swarmItem: 'src/a.ts' },
    });

    const next = await meta.read();
    expect(next.agents?.['main']?.labels).toEqual({ swarmItem: 'src/a.ts' });
    expect(next.updatedAt).toBe(before);
  });

  it('records the fresh summary into the session index mirror on update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toHaveLength(1);

    await meta.update({ title: 'mirrored' });

    expect(mirror.recorded).toHaveLength(2);
    expect(mirror.recorded[1]).toMatchObject({
      id: 's1',
      workspaceId: 'wd_test',
      title: 'mirrored',
      archived: false,
    });
    expect(mirror.recorded[1]?.updatedAt).toBe((await meta.read()).updatedAt);
  });

  it('does not re-record when loading an existing document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.setArchived(true);
    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]?.archived).toBe(true);
  });

  it('skips an unchanged non-agents patch without writing or firing', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });

    await meta.update({ title: 'same' }, { touchUpdatedAt: false });
    await meta.update({ title: 'same' }, { touchUpdatedAt: false });
    await meta.update({ lastTurnReason: undefined }, { touchUpdatedAt: false });
    await meta.update({ custom: { a: [1, { b: 'c' }] } }, { touchUpdatedAt: false });
    await meta.update({ custom: { a: [1, { b: 'c' }] } }, { touchUpdatedAt: false });

    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(fired).toBe(2);

    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.setTitle('same');
    await meta.setTitle('same');

    expect(setSpy).toHaveBeenCalledTimes(3);
    expect(fired).toBe(3);
    expect((await meta.read()).titleKind).toBe('custom');
    expect((await meta.read()).updatedAt).toBe(before);
    sub.dispose();
  });

  it('skips setArchived on an already-archived session', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.setArchived(true);
    const store = ix.get(IAtomicDocumentStore);
    const setSpy = vi.spyOn(store, 'set');
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    const archivedAt = (await meta.read()).archivedAt;

    await meta.setArchived(true);

    expect(setSpy).not.toHaveBeenCalled();
    expect(fired).toBe(0);
    expect((await meta.read()).archivedAt).toBe(archivedAt);
    sub.dispose();
  });

  it('restores the previous non-agents state when the write rejects', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const before = await meta.read();
    const store = ix.get(IAtomicDocumentStore);
    vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('disk full'));
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    const mirrored = mirror.recorded.length;

    await expect(meta.update({ title: 'lost' })).rejects.toThrow('disk full');

    expect(fired).toBe(0);
    expect(mirror.recorded).toHaveLength(mirrored);
    expect(await meta.read()).toMatchObject({ updatedAt: before.updatedAt });
    expect((await meta.read()).title).toBeUndefined();

    await meta.update({ lastPrompt: 'kept' });
    const persisted = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ lastPrompt: 'kept' });
    expect(persisted?.title).toBeUndefined();
    sub.dispose();
  });

  it('restores the previous agents when the write rejects', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', { type: 'main' });
    const store = ix.get(IAtomicDocumentStore);
    vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('agents down'));
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    const mirrored = mirror.recorded.length;

    await expect(meta.registerAgent('sub', { type: 'sub' })).rejects.toThrow('agents down');

    expect(fired).toBe(0);
    expect(mirror.recorded).toHaveLength(mirrored);
    expect((await meta.read()).agents).toEqual({ main: { type: 'main' } });
    const persisted = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    expect(persisted?.agents).toEqual({ main: { type: 'main' } });
    sub.dispose();
  });

  it('drain awaits a write enqueued while it is already draining', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let call = 0;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      call += 1;
      if (call === 1) {
        markFirstStarted?.();
        await firstReleased;
      }
      if (call === 2) {
        markSecondStarted?.();
        await secondReleased;
      }
      await set(scope, key, value);
    });

    const first = meta.update({ title: 'first' });
    await firstStarted;
    const drained = drainSessionMetadataWrites();
    const second = meta.update({ title: 'second' });
    let drainedSettled = false;
    void drained.then(() => {
      drainedSettled = true;
    });
    try {
      releaseFirst?.();
      await secondStarted;
      await new Promise((r) => setTimeout(r, 0));
      expect(drainedSettled).toBe(false);
    } finally {
      releaseFirst?.();
      releaseSecond?.();
    }

    await drained;
    expect(await store.get<SessionMeta>(META_SCOPE, 'state.json')).toMatchObject({
      title: 'second',
    });
    await Promise.all([first, second]);
  });

  it('drain awaits the document written during load', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      markWriteStarted?.();
      await writeReleased;
      await set(scope, key, value);
    });

    ix.get(ISessionMetadata);
    await writeStarted;
    const drained = drainSessionMetadataWrites();
    let drainedSettled = false;
    void drained.then(() => {
      drainedSettled = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 0));
      expect(drainedSettled).toBe(false);
      expect(await store.get(META_SCOPE, 'state.json')).toBeUndefined();
    } finally {
      releaseWrite?.();
    }

    await drained;
    expect(await store.get(META_SCOPE, 'state.json')).toMatchObject({ id: 's1' });
  });

  it('keeps draining the queue after a drain microtask rejection', async () => {
    const warn = vi.fn();
    ix.stub(ILogService, { ...stubLog(), warn });
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const internals = meta as unknown as { drainTasks(): Promise<void> };
    vi.spyOn(internals, 'drainTasks').mockRejectedValueOnce(new Error('drain exploded'));

    await expect(meta.update({ title: 'after rejection' })).resolves.toBeUndefined();

    expect(await meta.read()).toMatchObject({ title: 'after rejection' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('drain failed'),
      expect.objectContaining({ sessionId: 's1', error: 'drain exploded' }),
    );
  });
});
