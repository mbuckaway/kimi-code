/**
 * `hostFsWatch` domain — unit tests for the backend selection and the
 * `fsevents` flag mapping (with a stubbed native module), plus integration
 * tests against the real watcher on a temporary directory. On macOS the
 * integration tests exercise the `fsevents` backend.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFsEventsWatcher,
  loadFsevents,
  mapFsEventsFlags,
  resolveRenameEvent,
  type FseventsConstants,
  type FseventsModule,
  type FsEventsEventName,
} from '#/os/backends/node-local/fsEventsWatcher';
import { HostFsWatchService, resolveBackend } from '#/os/backends/node-local/hostFsWatchService';
import type { HostFsChange, IHostFsWatchHandle } from '#/os/interface/hostFsWatch';

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
  it('maps an existing path to add / addDir', () => {
    expect(resolveRenameEvent(true, false)).toBe('add');
    expect(resolveRenameEvent(true, true)).toBe('addDir');
  });

  it('maps a missing path to unlink', () => {
    expect(resolveRenameEvent(false, false)).toBe('unlink');
  });
});

describe('createFsEventsWatcher', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

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

describe('HostFsWatchService', () => {
  let root: string;
  let handle: IHostFsWatchHandle | undefined;

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function start(recursive = true): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive });
    handle.onDidChange((e) => events.push(e));
    await wait(200);
    return events;
  }

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
