/**
 * `hostFsWatch` domain — macOS `fsevents` backend.
 *
 * Loads the darwin-only native `fsevents` module lazily through
 * `createRequire` (it is an optional dependency, absent on other platforms)
 * and runs one `FSEventStream` per watched tree, so watching a large
 * workspace costs O(1) file descriptors instead of one `fs.watch` handle per
 * file. Raw flags are first classified by the pure `mapFsEventsFlags`, then
 * reconciled against per-path state to match chokidar semantics:
 * `ignoreInitial` is emulated by suppressing events whose mtime predates the
 * watch start (FSEvents delivers a stale event for paths written just before
 * stream start), the sticky `ItemCreated` bit FSEvents keeps setting on
 * later writes degrades to `change`, and a coalesced created+removed pair is
 * a deletion when the path was already reported, a transient file otherwise.
 * FSEvents only streams from existing directories, so a file target (or a
 * not-yet-existing path) is served by streaming the nearest existing ancestor
 * directory and keeping only events for the target itself, matching chokidar.
 * Event paths are rewritten from the kernel-reported real path back to the
 * caller-given root (macOS `/var` vs `/private/var`). Note: an active
 * `fsevents` watch keeps the Node process alive (the native handle cannot be
 * unref'd). Used by `hostFsWatchService` on macOS; chokidar remains the
 * backend elsewhere.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export type FsEventsEventName = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface FseventsConstants {
  readonly MustScanSubDirs: number;
  readonly RootChanged: number;
  readonly ItemCreated: number;
  readonly ItemRemoved: number;
  readonly ItemInodeMetaMod: number;
  readonly ItemRenamed: number;
  readonly ItemModified: number;
  readonly ItemChangeOwner: number;
  readonly ItemXattrMod: number;
  readonly ItemIsFile: number;
  readonly ItemIsDir: number;
}

export interface FseventsModule {
  watch(path: string, handler: (path: string, flags: number, id: string) => void): () => Promise<void>;
  constants: FseventsConstants;
}

export interface FsEventsWatchOptions {
  readonly recursive?: boolean;
  readonly ignored?: (path: string) => boolean;
}

export interface FsEventsWatcher {
  close(): Promise<void>;
}

export type FsEventsFlagAction =
  | { readonly type: 'event'; readonly eventName: FsEventsEventName }
  | { readonly type: 'rename' }
  | { readonly type: 'dataLoss' }
  | { readonly type: 'skip' };

export function mapFsEventsFlags(flags: number, constants: FseventsConstants): FsEventsFlagAction {
  if (flags & (constants.MustScanSubDirs | constants.RootChanged)) return { type: 'dataLoss' };
  const created = (flags & constants.ItemCreated) !== 0;
  const removed = (flags & constants.ItemRemoved) !== 0;
  if (created && removed) return { type: 'skip' };
  if (flags & constants.ItemRenamed) return { type: 'rename' };
  const isDir = (flags & constants.ItemIsDir) !== 0;
  if (created) return { type: 'event', eventName: isDir ? 'addDir' : 'add' };
  if (removed) return { type: 'event', eventName: isDir ? 'unlinkDir' : 'unlink' };
  const changed =
    (flags &
      (constants.ItemModified |
        constants.ItemInodeMetaMod |
        constants.ItemXattrMod |
        constants.ItemChangeOwner)) !==
    0;
  if (changed) return { type: 'event', eventName: 'change' };
  return { type: 'skip' };
}

export function resolveRenameEvent(exists: boolean, isDir: boolean): FsEventsEventName {
  if (!exists) return 'unlink';
  return isDir ? 'addDir' : 'add';
}

let fseventsLoaded = false;
let fseventsCache: FseventsModule | undefined;

export function loadFsevents(): FseventsModule | undefined {
  if (!fseventsLoaded) {
    fseventsLoaded = true;
    try {
      const nodeRequire = createRequire(import.meta.url);
      fseventsCache = nodeRequire('fsevents') as FseventsModule;
    } catch {
      fseventsCache = undefined;
    }
  }
  return fseventsCache;
}

export function createFsEventsWatcher(
  fseventsModule: FseventsModule,
  path: string,
  options: FsEventsWatchOptions | undefined,
  onEvent: (eventName: FsEventsEventName, absPath: string) => void,
  onError: (error: unknown) => void,
): FsEventsWatcher {
  const { constants } = fseventsModule;
  const startedAt = performance.timeOrigin + performance.now();
  const known = new Set<string>();
  let closed = false;

  const targetStat = lstatSync(path, { throwIfNoEntry: false });
  const fileOnly = targetStat?.isDirectory() !== true;
  let watchBase = fileOnly ? dirname(path) : path;
  let watchRoot: string;
  for (;;) {
    try {
      watchRoot = realpathSync(watchBase);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(watchBase);
      if (parent === watchBase) throw error;
      watchBase = parent;
    }
  }

  const emitCreated = (eventPath: string, isDir: boolean): void => {
    if (known.has(eventPath)) {
      onEvent('change', eventPath);
      return;
    }
    const stat = lstatSync(eventPath, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.mtimeMs <= startedAt) return;
    known.add(eventPath);
    onEvent(isDir ? 'addDir' : 'add', eventPath);
  };

  const emitRemoved = (eventPath: string, isDir: boolean): void => {
    known.delete(eventPath);
    onEvent(isDir ? 'unlinkDir' : 'unlink', eventPath);
  };

  const emitChange = (eventPath: string): void => {
    if (known.has(eventPath)) {
      onEvent('change', eventPath);
      return;
    }
    const stat = lstatSync(eventPath, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.mtimeMs <= startedAt) return;
    onEvent('change', eventPath);
  };

  const emitTransient = (eventPath: string, flags: number): void => {
    const stat = lstatSync(eventPath, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (known.has(eventPath)) emitRemoved(eventPath, (flags & constants.ItemIsDir) !== 0);
      return;
    }
    emitCreated(eventPath, stat.isDirectory());
  };

  const stop = fseventsModule.watch(watchRoot, (rawPath, flags) => {
    if (closed) return;
    const eventPath = rawPath.startsWith(watchRoot)
      ? watchBase + rawPath.slice(watchRoot.length)
      : rawPath;
    if (fileOnly ? eventPath !== path : eventPath === path) return;
    try {
      if (options?.ignored?.(eventPath) === true) return;
      if (!fileOnly && options?.recursive === false && dirname(eventPath) !== path) return;
      const action = mapFsEventsFlags(flags, constants);
      switch (action.type) {
        case 'event':
          if (action.eventName === 'add' || action.eventName === 'addDir') {
            emitCreated(eventPath, action.eventName === 'addDir');
          } else if (action.eventName === 'change') {
            emitChange(eventPath);
          } else {
            emitRemoved(eventPath, action.eventName === 'unlinkDir');
          }
          return;
        case 'rename': {
          const stat = lstatSync(eventPath, { throwIfNoEntry: false });
          if (stat === undefined) {
            if (known.delete(eventPath)) onEvent('unlink', eventPath);
            return;
          }
          if (known.has(eventPath)) {
            onEvent('change', eventPath);
            return;
          }
          known.add(eventPath);
          onEvent(resolveRenameEvent(true, stat.isDirectory()), eventPath);
          return;
        }
        case 'dataLoss':
          onError(new Error(`fsevents reported a data-loss event for: ${eventPath}`));
          return;
        case 'skip':
          if ((flags & constants.ItemCreated) !== 0 && (flags & constants.ItemRemoved) !== 0) {
            emitTransient(eventPath, flags);
          }
          return;
      }
    } catch (error) {
      onError(error);
    }
  });
  return {
    close(): Promise<void> {
      closed = true;
      return stop();
    },
  };
}
