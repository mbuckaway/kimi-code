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

export function resolveRenameEvent(isDir: boolean): FsEventsEventName {
  return isDir ? 'addDir' : 'add';
}

export const FS_EVENTS_KNOWN_PATH_LIMIT = 2048;

export interface KnownPathSet {
  readonly size: number;
  has(path: string): boolean;
  remember(path: string): void;
  forget(path: string): boolean;
}

export function createKnownPathSet(limit: number = FS_EVENTS_KNOWN_PATH_LIMIT): KnownPathSet {
  const paths = new Set<string>();
  return {
    get size(): number {
      return paths.size;
    },
    has: (path) => paths.has(path),
    remember: (path) => {
      paths.delete(path);
      paths.add(path);
      while (paths.size > limit) {
        const oldest = paths.values().next().value;
        if (oldest === undefined) return;
        paths.delete(oldest);
      }
    },
    forget: (path) => paths.delete(path),
  };
}

export function isFseventsModule(value: unknown): value is FseventsModule {
  if (typeof value !== 'object' || value === null) return false;
  if (!('watch' in value) || !('constants' in value)) return false;
  return (
    typeof value.watch === 'function' &&
    typeof value.constants === 'object' &&
    value.constants !== null
  );
}

let fseventsLoaded = false;
let fseventsCache: FseventsModule | undefined;

export function loadFsevents(): FseventsModule | undefined {
  if (!fseventsLoaded) {
    fseventsLoaded = true;
    try {
      const nodeRequire = createRequire(import.meta.url);
      const loaded: unknown = nodeRequire('fsevents');
      fseventsCache = isFseventsModule(loaded) ? loaded : undefined;
    } catch {
      fseventsCache = undefined;
    }
  }
  return fseventsCache;
}

interface FsEventsWatchTarget {
  readonly fileOnly: boolean;
  readonly watchBase: string;
  readonly watchRoot: string;
}

interface FsEventsReconciler {
  readonly constants: FseventsConstants;
  readonly known: KnownPathSet;
  readonly startedAt: number;
  readonly onEvent: (eventName: FsEventsEventName, absPath: string) => void;
  readonly onError: (error: unknown) => void;
}

function resolveWatchTarget(path: string): FsEventsWatchTarget {
  const targetStat = lstatSync(path, { throwIfNoEntry: false });
  const fileOnly = targetStat?.isDirectory() !== true;
  let watchBase = fileOnly ? dirname(path) : path;
  for (;;) {
    try {
      return { fileOnly, watchBase, watchRoot: realpathSync(watchBase) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(watchBase);
      if (parent === watchBase) throw error;
      watchBase = parent;
    }
  }
}

function emitCreated(reconciler: FsEventsReconciler, eventPath: string, isDir: boolean): void {
  if (reconciler.known.has(eventPath)) {
    reconciler.onEvent('change', eventPath);
    return;
  }
  const stat = lstatSync(eventPath, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.mtimeMs <= reconciler.startedAt) return;
  reconciler.known.remember(eventPath);
  reconciler.onEvent(isDir ? 'addDir' : 'add', eventPath);
}

function emitRemoved(reconciler: FsEventsReconciler, eventPath: string, isDir: boolean): void {
  reconciler.known.forget(eventPath);
  reconciler.onEvent(isDir ? 'unlinkDir' : 'unlink', eventPath);
}

function emitChange(reconciler: FsEventsReconciler, eventPath: string): void {
  if (reconciler.known.has(eventPath)) {
    reconciler.onEvent('change', eventPath);
    return;
  }
  const stat = lstatSync(eventPath, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.mtimeMs <= reconciler.startedAt) return;
  reconciler.onEvent('change', eventPath);
}

function emitRenamed(reconciler: FsEventsReconciler, eventPath: string): void {
  const stat = lstatSync(eventPath, { throwIfNoEntry: false });
  if (stat === undefined) {
    if (reconciler.known.forget(eventPath)) reconciler.onEvent('unlink', eventPath);
    return;
  }
  if (reconciler.known.has(eventPath)) {
    reconciler.onEvent('change', eventPath);
    return;
  }
  reconciler.known.remember(eventPath);
  reconciler.onEvent(resolveRenameEvent(stat.isDirectory()), eventPath);
}

function emitTransient(reconciler: FsEventsReconciler, eventPath: string, flags: number): void {
  const stat = lstatSync(eventPath, { throwIfNoEntry: false });
  if (stat === undefined) {
    if (reconciler.known.has(eventPath)) {
      emitRemoved(reconciler, eventPath, (flags & reconciler.constants.ItemIsDir) !== 0);
    }
    return;
  }
  emitCreated(reconciler, eventPath, stat.isDirectory());
}

function reconcile(reconciler: FsEventsReconciler, eventPath: string, flags: number): void {
  const action = mapFsEventsFlags(flags, reconciler.constants);
  switch (action.type) {
    case 'event':
      if (action.eventName === 'add' || action.eventName === 'addDir') {
        emitCreated(reconciler, eventPath, action.eventName === 'addDir');
      } else if (action.eventName === 'change') {
        emitChange(reconciler, eventPath);
      } else {
        emitRemoved(reconciler, eventPath, action.eventName === 'unlinkDir');
      }
      return;
    case 'rename':
      emitRenamed(reconciler, eventPath);
      return;
    case 'dataLoss':
      reconciler.onError(new Error(`fsevents reported a data-loss event for: ${eventPath}`));
      return;
    case 'skip':
      if (
        (flags & reconciler.constants.ItemCreated) !== 0 &&
        (flags & reconciler.constants.ItemRemoved) !== 0
      ) {
        emitTransient(reconciler, eventPath, flags);
      }
      return;
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return;
    }
  }
}

export function createFsEventsWatcher(
  fseventsModule: FseventsModule,
  path: string,
  options: FsEventsWatchOptions | undefined,
  onEvent: (eventName: FsEventsEventName, absPath: string) => void,
  onError: (error: unknown) => void,
): FsEventsWatcher {
  const reconciler: FsEventsReconciler = {
    constants: fseventsModule.constants,
    known: createKnownPathSet(),
    startedAt: performance.timeOrigin + performance.now(),
    onEvent,
    onError,
  };
  const { fileOnly, watchBase, watchRoot } = resolveWatchTarget(path);
  let closed = false;

  const stop = fseventsModule.watch(watchRoot, (rawPath, flags) => {
    if (closed) return;
    const eventPath = rawPath.startsWith(watchRoot)
      ? watchBase + rawPath.slice(watchRoot.length)
      : rawPath;
    if (fileOnly ? eventPath !== path : eventPath === path) return;
    try {
      if (options?.ignored?.(eventPath) === true) return;
      if (!fileOnly && options?.recursive === false && dirname(eventPath) !== path) return;
      reconcile(reconciler, eventPath, flags);
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
