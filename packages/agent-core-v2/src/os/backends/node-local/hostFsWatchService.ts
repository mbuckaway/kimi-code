/**
 * `hostFsWatch` domain — `IHostFsWatchService` implementation.
 *
 * Reports raw create/modify/delete events under an absolute path through one
 * of two backends: on macOS the native `fsevents` module (one FSEventStream
 * per tree, O(1) file descriptors — see `fsEventsWatcher`), elsewhere
 * `chokidar` (one `fs.watch` handle per file, which would exhaust
 * descriptors on large macOS workspaces). Each `watch()` call owns an
 * independent watcher; disposing the handle closes it. Bound at App scope.
 */

import { FSWatcher } from 'chokidar';

import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import {
  createFsEventsWatcher,
  loadFsevents,
  type FseventsModule,
  type FsEventsWatcher,
} from '#/os/backends/node-local/fsEventsWatcher';
import {
  type HostFsChange,
  type HostFsChangeAction,
  type HostFsChangeKind,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

export type HostFsWatchBackend = 'chokidar' | 'fsevents';

export function resolveBackend(platform: NodeJS.Platform, hasFsevents: boolean): HostFsWatchBackend {
  if (platform === 'darwin' && hasFsevents) return 'fsevents';
  return 'chokidar';
}

let warnedMissingFsevents = false;

function warnMissingFseventsOnce(): void {
  if (warnedMissingFsevents) return;
  warnedMissingFsevents = true;
  // eslint-disable-next-line no-console -- deliberate user-facing warning; no logger exists at this layer
  console.warn(
    'hostFsWatch: fsevents unavailable on macOS, falling back to chokidar ' +
      '(one fs.watch handle per file — large workspaces may exhaust file descriptors)',
  );
}

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher | FsEventsWatcher;
  private disposed = false;

  constructor(
    path: string,
    options: HostFsWatchOptions | undefined,
    backend: HostFsWatchBackend,
    fseventsModule: FseventsModule | undefined,
  ) {
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    const emit = (eventName: string, absPath: string): void => {
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    };
    if (backend === 'fsevents' && fseventsModule !== undefined) {
      this.watcher = createFsEventsWatcher(
        fseventsModule,
        path,
        { recursive: options?.recursive, ignored: options?.ignored ?? DEFAULT_IGNORED },
        emit,
        onUnexpectedError,
      );
      return;
    }
    const watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      depth: options?.recursive === false ? 0 : undefined,
      ignored: options?.ignored ?? DEFAULT_IGNORED,
    });
    watcher.on('all', emit);
    watcher.on('error', (error: unknown) => {
      onUnexpectedError(error);
    });
    watcher.add(path);
    this.watcher = watcher;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    const fseventsModule = loadFsevents();
    const backend = resolveBackend(process.platform, fseventsModule !== undefined);
    if (backend === 'chokidar' && process.platform === 'darwin') warnMissingFseventsOnce();
    return new HostFsWatchHandle(path, options, backend, fseventsModule);
  }
}

function mapChokidarEvent(eventName: string, absPath: string): HostFsChange | undefined {
  const mapped = mapActionAndKind(eventName);
  if (mapped === undefined) return undefined;
  return { path: absPath, action: mapped.action, kind: mapped.kind };
}

function mapActionAndKind(
  eventName: string,
): { action: HostFsChangeAction; kind: HostFsChangeKind } | undefined {
  switch (eventName) {
    case 'add':
      return { action: 'created', kind: 'file' };
    case 'addDir':
      return { action: 'created', kind: 'directory' };
    case 'change':
      return { action: 'modified', kind: 'file' };
    case 'unlink':
      return { action: 'deleted', kind: 'file' };
    case 'unlinkDir':
      return { action: 'deleted', kind: 'directory' };
    default:
      return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFsWatchService,
  HostFsWatchService,
  ScopeActivation.OnScopeCreated,
  'hostFsWatch',
);
