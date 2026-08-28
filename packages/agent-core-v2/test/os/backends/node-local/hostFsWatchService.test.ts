import { readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { ILogService } from '#/_base/log/log';
import {
  createFsEventsWatcher,
  createKnownPathSet,
  isFseventsModule,
  loadFsevents,
  mapFsEventsFlags,
  resolveRenameEvent,
  FS_EVENTS_KNOWN_PATH_LIMIT,
  type FseventsConstants,
  type FseventsModule,
  type FsEventsEventName,
} from '#/os/backends/node-local/fsEventsWatcher';
import { HostFsWatchService, resolveBackend } from '#/os/backends/node-local/hostFsWatchService';
import type {
  HostFsChange,
  IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

import { stubLog } from '../../../_base/log/stubs';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await wait(50);
  }
}

const FLAGS: FseventsConstants = {
  MustScanSubDirs: 0x00000001,
  RootChanged: 0x00000020,
  ItemCreated: 0x00000100,
  ItemRemoved: 0x00000200,
  ItemInodeMetaMod: 0x00000400,
  ItemRenamed: 0x00000800,
  ItemModified: 0x00001000,
  ItemChangeOwner: 0x00004000,
  ItemXattrMod: 0x00008000,
  ItemIsFile: 0x00010000,
  ItemIsDir: 0x00020000,
};

type HostFsWatchRuntime = NonNullable<ConstructorParameters<typeof HostFsWatchService>[1]>;

function makeFakeFsevents(): {
  module: FseventsModule;
  fire: (path: string, flags: number) => void;
} {
  let handler: ((path: string, flags: number, id: string) => void) | undefined;
  const module: FseventsModule = {
    watch: (_path, h) => {
      handler = h;
      return () => Promise.resolve();
    },
    constants: FLAGS,
  };
  return { module, fire: (p, f) => handler?.(p, f, '0') };
}

function recordingLog(warnings: string[]): ILogService {
  return {
    ...stubLog(),
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

class TestNativeWatcher {
  private errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
  closed = false;

  on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void): this {
    this.errorListener = listener;
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fail(code = 'EIO'): void {
    this.errorListener?.(Object.assign(new Error('native watch failed'), { code }));
  }
}

interface TestNativeAttempt {
  readonly watcher: TestNativeWatcher;
  emit(filename: string | null): void;
}

interface TestRetry {
  readonly delayMs: number;
  readonly active: boolean;
  run(): void;
}

function signalRig(options?: { readonly synchronousFailures?: number }): {
  readonly service: IHostFsWatchService;
  readonly attempts: TestNativeAttempt[];
  readonly retries: TestRetry[];
  attempt(index: number): TestNativeAttempt;
  retry(index: number): TestRetry;
} {
  const attempts: TestNativeAttempt[] = [];
  const retries: TestRetry[] = [];
  let synchronousFailures = options?.synchronousFailures ?? 0;
  const runtime: HostFsWatchRuntime = {
    platform: 'darwin',
    loadFsevents: () => undefined,
    watchNative: (_root, listener) => {
      if (synchronousFailures > 0) {
        synchronousFailures -= 1;
        throw Object.assign(new Error('native watch creation failed'), { code: 'EIO' });
      }
      const watcher = new TestNativeWatcher();
      attempts.push({
        watcher,
        emit: (filename) => {
          listener('rename', filename);
        },
      });
      return watcher;
    },
    scheduleRetry: (callback, delayMs) => {
      let active = true;
      retries.push({
        delayMs,
        get active() {
          return active;
        },
        run: () => {
          if (!active) return;
          active = false;
          callback();
        },
      });
      return {
        dispose: () => {
          active = false;
        },
      };
    },
  };
  return {
    service: new HostFsWatchService(stubLog(), runtime),
    attempts,
    retries,
    attempt: (index) => requiredAt(attempts, index),
    retry: (index) => requiredAt(retries, index),
  };
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test value at index ${index}`);
  return value;
}

describe('host filesystem change notifications', () => {
  let root: string;
  let handle: IHostFsWatchHandle | undefined;

  beforeEach(() => {
    setUnexpectedErrorHandler(() => undefined);
  });

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
    resetUnexpectedErrorHandler();
  });

  async function start(recursive = true): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  async function startSignal(ignored?: (path: string) => boolean): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive: true, signal: true, ignored });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  it('emits a coarse root invalidation when a native signal path changes', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('skills/demo/SKILL.md');

    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('does not invalidate when a native signal path is ignored', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', {
      signal: true,
      ignored: (path) => path.includes('node_modules'),
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('node_modules/pkg/index.js');

    expect(events).toEqual([]);
  });

  it('increases the retry delay after consecutive native failures', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).watcher.fail();
    rig.retry(1).run();
    rig.attempt(2).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it('invalidates again after a native watch is rearmed', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();

    expect(events).toEqual([
      { path: '/repo', action: 'modified', kind: 'directory' },
      { path: '/repo', action: 'modified', kind: 'directory' },
    ]);
  });

  it('invalidates after recovering from a synchronous native-watch creation failure', () => {
    const rig = signalRig({ synchronousFailures: 1 });
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.retry(0).run();

    expect(rig.attempts).toHaveLength(1);
    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('resets the retry delay after the recovered native watch emits an event', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).emit('skills/demo/SKILL.md');
    rig.attempt(1).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 1000]);
  });

  it('cancels a pending native retry when the watch handle is disposed', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });
    rig.attempt(0).watcher.fail();

    handle.dispose();
    handle = undefined;
    rig.retry(0).run();

    expect(rig.retry(0).active).toBe(false);
    expect(rig.attempt(0).watcher.closed).toBe(true);
    expect(rig.attempts).toHaveLength(1);
  });

  it('reports create / modify / delete for a file', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    await wait(300);
    await writeFile(file, 'v2');
    await wait(300);
    await rm(file);
    await wait(300);

    const actions = events.filter((e) => e.path === file).map((e) => e.action);
    expect(actions).toContain('created');
    expect(actions).toContain('modified');
    expect(actions).toContain('deleted');
    expect(events.find((e) => e.path === file)?.kind).toBe('file');
  });

  it('does not fire for paths ignored by default (.git)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('/.git/') || e.path.endsWith('/.git'))).toBe(false);
  });

  it('does not fire for pre-existing files (ignoreInitial)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');

    const events = await start();
    await wait(300);

    expect(events.some((e) => e.path === preexisting)).toBe(false);
  });

  it('stops firing after the handle is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    handle?.dispose();
    handle = undefined;

    await writeFile(join(root, 'after-dispose.txt'), 'x');
    await wait(300);

    expect(events).toHaveLength(0);
  });

  it.skipIf(process.platform !== 'darwin')(
    'signal mode keeps the fd footprint bounded on a fat subtree',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'hostfswatch-fat-'));
      const fat = join(root, 'fat');
      await mkdir(fat, { recursive: true });
      for (let i = 0; i < 1200; i++) {
        await writeFile(join(fat, `f${i}.txt`), 'x');
      }

      const fdsBefore = readdirSync('/dev/fd').length;
      await startSignal();
      const fdsAfter = readdirSync('/dev/fd').length;

      expect(fdsAfter - fdsBefore).toBeLessThan(50);
    },
    30000,
  );

  it.runIf(process.platform === 'darwin' && loadFsevents() !== undefined)(
    'watches a tree of thousands of files without descriptor exhaustion',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'hostfswatch-scale-'));

      for (let d = 0; d < 40; d += 1) {
        const dir = join(root, `dir-${d}`);
        await mkdir(dir);
        for (let f = 0; f < 50; f += 1) {
          await writeFile(join(dir, `file-${f}.txt`), 'seed');
        }
      }

      const events = await start();

      const created: string[] = [];
      for (let d = 0; d < 10; d += 1) {
        const dir = join(root, `live-${d}`);
        await mkdir(dir);
        for (let f = 0; f < 10; f += 1) {
          const file = join(dir, `live-${f}.txt`);
          await writeFile(file, 'live');
          created.push(file);
        }
      }

      await waitFor(() => created.every((p) => events.some((e) => e.path === p)), 30000);
      expect(created.every((p) => events.some((e) => e.path === p))).toBe(true);
    },
    60000,
  );
});

describe('resolveBackend', () => {
  it('picks fsevents on darwin when the module is available', () => {
    expect(resolveBackend('darwin', true)).toBe('fsevents');
  });

  it('falls back to chokidar on darwin without fsevents', () => {
    expect(resolveBackend('darwin', false)).toBe('chokidar');
  });

  it('picks chokidar on linux even when fsevents resolves', () => {
    expect(resolveBackend('linux', true)).toBe('chokidar');
    expect(resolveBackend('linux', false)).toBe('chokidar');
  });
});

describe('missing fsevents warning', () => {
  let root: string;
  const handles: IHostFsWatchHandle[] = [];

  beforeEach(() => {
    setUnexpectedErrorHandler(() => undefined);
  });

  afterEach(async () => {
    for (const openHandle of handles.splice(0)) openHandle.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
    resetUnexpectedErrorHandler();
  });

  function darwinRuntime(fsevents: FseventsModule | undefined): HostFsWatchRuntime {
    return {
      platform: 'darwin',
      loadFsevents: () => fsevents,
      watchNative: () => {
        throw new Error('native recursive watch is not expected here');
      },
      scheduleRetry: () => ({ dispose: () => undefined }),
    };
  }

  it('warns once about the chokidar fallback across repeated watches', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-warn-'));
    const warnings: string[] = [];
    const service = new HostFsWatchService(recordingLog(warnings), darwinRuntime(undefined));

    handles.push(service.watch(root), service.watch(root));

    expect(warnings).toEqual([expect.stringContaining('fsevents unavailable on macOS')]);
  });

  it('does not warn when fsevents is available on darwin', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-warn-'));
    const warnings: string[] = [];
    const service = new HostFsWatchService(
      recordingLog(warnings),
      darwinRuntime(makeFakeFsevents().module),
    );

    handles.push(service.watch(root));

    expect(warnings).toEqual([]);
  });
});

describe('mapFsEventsFlags', () => {
  it('maps ItemCreated to add / addDir by kind flag', () => {
    expect(mapFsEventsFlags(FLAGS.ItemCreated | FLAGS.ItemIsFile, FLAGS)).toEqual({
      type: 'event',
      eventName: 'add',
    });
    expect(mapFsEventsFlags(FLAGS.ItemCreated | FLAGS.ItemIsDir, FLAGS)).toEqual({
      type: 'event',
      eventName: 'addDir',
    });
  });

  it('maps ItemRemoved to unlink / unlinkDir by kind flag', () => {
    expect(mapFsEventsFlags(FLAGS.ItemRemoved | FLAGS.ItemIsFile, FLAGS)).toEqual({
      type: 'event',
      eventName: 'unlink',
    });
    expect(mapFsEventsFlags(FLAGS.ItemRemoved | FLAGS.ItemIsDir, FLAGS)).toEqual({
      type: 'event',
      eventName: 'unlinkDir',
    });
  });

  it('maps modification flags to change', () => {
    const modified =
      FLAGS.ItemModified | FLAGS.ItemInodeMetaMod | FLAGS.ItemXattrMod | FLAGS.ItemChangeOwner;
    expect(mapFsEventsFlags(modified | FLAGS.ItemIsFile, FLAGS)).toEqual({
      type: 'event',
      eventName: 'change',
    });
  });

  it('maps ItemRenamed to the rename resolution step', () => {
    expect(mapFsEventsFlags(FLAGS.ItemRenamed | FLAGS.ItemIsFile, FLAGS)).toEqual({
      type: 'rename',
    });
  });

  it('skips transient created+removed events', () => {
    expect(
      mapFsEventsFlags(FLAGS.ItemCreated | FLAGS.ItemRemoved | FLAGS.ItemIsFile, FLAGS),
    ).toEqual({ type: 'skip' });
  });

  it('reports MustScanSubDirs / RootChanged as data loss', () => {
    expect(mapFsEventsFlags(FLAGS.MustScanSubDirs, FLAGS)).toEqual({ type: 'dataLoss' });
    expect(mapFsEventsFlags(FLAGS.RootChanged, FLAGS)).toEqual({ type: 'dataLoss' });
  });

  it('skips flags with no known change bits', () => {
    expect(mapFsEventsFlags(0, FLAGS)).toEqual({ type: 'skip' });
  });
});

describe('resolveRenameEvent', () => {
  it('maps a rename target to add / addDir by kind', () => {
    expect(resolveRenameEvent(false)).toBe('add');
    expect(resolveRenameEvent(true)).toBe('addDir');
  });
});

describe('isFseventsModule', () => {
  it('accepts a module exposing watch and constants', () => {
    expect(isFseventsModule({ watch: () => () => Promise.resolve(), constants: FLAGS })).toBe(true);
  });

  it('rejects values that do not match the fsevents shape', () => {
    expect(isFseventsModule(undefined)).toBe(false);
    expect(isFseventsModule(null)).toBe(false);
    expect(isFseventsModule('fsevents')).toBe(false);
    expect(isFseventsModule({})).toBe(false);
    expect(isFseventsModule({ watch: () => undefined })).toBe(false);
    expect(isFseventsModule({ watch: 'nope', constants: FLAGS })).toBe(false);
    expect(isFseventsModule({ watch: () => undefined, constants: null })).toBe(false);
  });
});

describe('createKnownPathSet', () => {
  it('evicts the oldest path once the limit is exceeded', () => {
    const known = createKnownPathSet(3);

    for (const path of ['a', 'b', 'c', 'd', 'e']) known.remember(path);

    expect(known.size).toBe(3);
    expect([known.has('a'), known.has('b')]).toEqual([false, false]);
    expect([known.has('c'), known.has('d'), known.has('e')]).toEqual([true, true, true]);
  });

  it('reports whether a forgotten path was known', () => {
    const known = createKnownPathSet(2);
    known.remember('a');

    expect([known.forget('a'), known.forget('a')]).toEqual([true, false]);
    expect(known.size).toBe(0);
  });
});

describe('createFsEventsWatcher', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('drops non-recursive events outside the watched root', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    createFsEventsWatcher(
      module,
      root,
      { recursive: false },
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    await wait(10);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'deep.txt'), 'x');
    await writeFile(join(root, 'top.txt'), 'x');
    fire(join(root, 'nested', 'deep.txt'), FLAGS.ItemCreated | FLAGS.ItemIsFile);
    fire(join(root, 'top.txt'), FLAGS.ItemCreated | FLAGS.ItemIsFile);

    expect(events).toEqual([['add', join(root, 'top.txt')]]);
  });

  it('honors the ignored predicate with the absolute path', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    const seen: string[] = [];
    const ignoredFile = join(root, '.git', 'config');
    const okFile = join(root, 'ok.txt');
    createFsEventsWatcher(
      module,
      root,
      { ignored: (p) => (seen.push(p), p.includes('.git')) },
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    await wait(10);
    await writeFile(okFile, 'x');
    fire(ignoredFile, FLAGS.ItemCreated | FLAGS.ItemIsFile);
    fire(okFile, FLAGS.ItemCreated | FLAGS.ItemIsFile);

    expect(events).toEqual([['add', okFile]]);
    expect(seen).toEqual([ignoredFile, okFile]);
  });

  it('suppresses events for files whose mtime predates the watch start', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');
    await wait(10);

    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    createFsEventsWatcher(
      module,
      root,
      undefined,
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    fire(preexisting, FLAGS.ItemCreated | FLAGS.ItemIsFile);

    expect(events).toEqual([]);
  });

  it('degrades a repeated ItemCreated for a known path to change', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    createFsEventsWatcher(
      module,
      root,
      undefined,
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    const file = join(root, 'a.txt');
    await wait(10);
    await writeFile(file, 'v1');
    fire(file, FLAGS.ItemCreated | FLAGS.ItemIsFile);
    await writeFile(file, 'v2');
    fire(file, FLAGS.ItemCreated | FLAGS.ItemInodeMetaMod | FLAGS.ItemIsFile);

    expect(events).toEqual([
      ['add', file],
      ['change', file],
    ]);
  });

  it('reports created+removed for a known path as unlink, skips it otherwise', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    createFsEventsWatcher(
      module,
      root,
      undefined,
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    const file = join(root, 'a.txt');
    await wait(10);
    await writeFile(file, 'v1');
    fire(file, FLAGS.ItemCreated | FLAGS.ItemIsFile);
    await rm(file);
    fire(file, FLAGS.ItemCreated | FLAGS.ItemRemoved | FLAGS.ItemIsFile);
    fire(join(root, 'never-seen.txt'), FLAGS.ItemCreated | FLAGS.ItemRemoved | FLAGS.ItemIsFile);

    expect(events).toEqual([
      ['add', file],
      ['unlink', file],
    ]);
  });

  it(
    'bounds the known-path set, reporting an evicted path as a new add',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
      const { module, fire } = makeFakeFsevents();
      const events: Array<[FsEventsEventName, string]> = [];
      createFsEventsWatcher(
        module,
        root,
        undefined,
        (eventName, absPath) => events.push([eventName, absPath]),
        () => undefined,
      );

      await wait(10);
      const files: string[] = [];
      for (let i = 0; i <= FS_EVENTS_KNOWN_PATH_LIMIT; i += 1) {
        const file = join(root, `f${i}.txt`);
        writeFileSync(file, 'x');
        files.push(file);
        fire(file, FLAGS.ItemCreated | FLAGS.ItemIsFile);
      }
      const evicted = requiredAt(files, 0);
      const retained = requiredAt(files, files.length - 1);
      fire(evicted, FLAGS.ItemCreated | FLAGS.ItemIsFile);
      fire(retained, FLAGS.ItemCreated | FLAGS.ItemIsFile);

      expect(events.filter(([, p]) => p === evicted).map(([name]) => name)).toEqual(['add', 'add']);
      expect(events.filter(([, p]) => p === retained).map(([name]) => name)).toEqual([
        'add',
        'change',
      ]);
    },
    30000,
  );

  it('reports data-loss flags through onError', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const errors: unknown[] = [];
    createFsEventsWatcher(
      module,
      root,
      undefined,
      () => undefined,
      (error) => errors.push(error),
    );

    fire(join(root, 'sub'), FLAGS.MustScanSubDirs);

    expect(errors).toHaveLength(1);
  });

  it('watches a single file target and ignores its siblings', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    const target = join(root, 'mcp.json');
    createFsEventsWatcher(
      module,
      target,
      undefined,
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    await wait(10);
    await writeFile(target, '{}');
    await writeFile(join(root, 'other.json'), '{}');
    fire(target, FLAGS.ItemCreated | FLAGS.ItemIsFile);
    fire(join(root, 'other.json'), FLAGS.ItemCreated | FLAGS.ItemIsFile);

    expect(events).toEqual([['add', target]]);
  });

  it('accepts a file target whose parent directory does not exist yet', async () => {
    root = await mkdtemp(join(tmpdir(), 'fsevents-unit-'));
    const { module, fire } = makeFakeFsevents();
    const events: Array<[FsEventsEventName, string]> = [];
    const target = join(root, 'sub', 'mcp.json');
    createFsEventsWatcher(
      module,
      target,
      undefined,
      (eventName, absPath) => events.push([eventName, absPath]),
      () => undefined,
    );

    await wait(10);
    await mkdir(join(root, 'sub'));
    await writeFile(target, '{}');
    fire(target, FLAGS.ItemCreated | FLAGS.ItemIsFile);

    expect(events).toEqual([['add', target]]);
  });
});
