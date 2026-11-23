import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CROSS_SESSION_HEARTBEAT_INTERVAL_MS = 15_000;
export const CROSS_SESSION_OFFLINE_AFTER_MS = 45_000;
export const CROSS_SESSION_STALE_AFTER_MS = 90_000;

export interface CrossSessionRegistration {
  readonly sessionId: string;
  readonly title?: string;
  readonly socketPath: string;
  readonly token: string;
  readonly pid: number;
  readonly heartbeatAt: number;
  readonly startedAt: number;
}

export interface CrossSessionRegisterInput {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly token: string;
  readonly title?: string;
  readonly pid?: number;
  readonly startedAt?: number;
}

export interface CrossSessionRegistryUpdate {
  readonly title?: string;
  readonly socketPath?: string;
  readonly token?: string;
}

export interface CrossSessionRegistryHandle {
  readonly sessionId: string;
  update(patch: CrossSessionRegistryUpdate): Promise<void>;
  release(): Promise<void>;
}

export interface ICrossSessionRegistry {
  register(input: CrossSessionRegisterInput): Promise<CrossSessionRegistryHandle>;
  listLive(): Promise<readonly CrossSessionRegistration[]>;
  get(sessionId: string): Promise<CrossSessionRegistration | undefined>;
  sweepStale(): Promise<void>;
  statusOf(entry: CrossSessionRegistration): 'live' | 'offline';
}

export interface CrossSessionRegistryOptions {
  readonly registryDir?: string;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly offlineAfterMs?: number;
  readonly staleAfterMs?: number;
}

const ENGINE_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REGISTRY_FILE_SUFFIX = '.json';

const TEMP_FILE_MARKER = `${REGISTRY_FILE_SUFFIX}.tmp.`;

const TEMP_FILE_MAX_AGE_MS = 60_000;

const REGISTRY_FS_CONCURRENCY = 8;

const REGISTRY_DIR_MODE = 0o700;

const REGISTRY_FILE_MODE = 0o600;

interface RegistryFileSnapshot {
  readonly entry: CrossSessionRegistration | undefined;
  readonly mtimeMs: number;
}

export function resolveCrossSessionRegistryDir(homeDir: string): string {
  return join(homeDir, 'messaging', 'registry');
}

export function isEngineSessionId(sessionId: string): boolean {
  return ENGINE_SESSION_ID.test(sessionId);
}

export function safeSessionFileName(sessionId: string): string {
  return isEngineSessionId(sessionId)
    ? sessionId
    : Buffer.from(sessionId, 'utf8').toString('hex');
}

function filePathFor(registryDir: string, sessionId: string): string {
  return join(registryDir, `${safeSessionFileName(sessionId)}${REGISTRY_FILE_SUFFIX}`);
}

function isRegistryFile(name: string): boolean {
  return name.endsWith(REGISTRY_FILE_SUFFIX);
}

function isTempRegistryFile(name: string): boolean {
  return name.includes(TEMP_FILE_MARKER);
}

function encode(info: CrossSessionRegistration): string {
  return JSON.stringify(info);
}

function decode(raw: string): CrossSessionRegistration | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<CrossSessionRegistration>;
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.heartbeatAt === 'number' &&
      typeof parsed.startedAt === 'number' &&
      (parsed.title === undefined || typeof parsed.title === 'string')
    ) {
      return {
        sessionId: parsed.sessionId,
        socketPath: parsed.socketPath,
        token: parsed.token,
        pid: parsed.pid,
        heartbeatAt: parsed.heartbeatAt,
        startedAt: parsed.startedAt,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readRegistrationFile(
  filePath: string,
): Promise<CrossSessionRegistration | undefined> {
  try {
    return decode(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function statOrUndefined(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function snapshotRegistryFile(
  filePath: string,
): Promise<RegistryFileSnapshot | undefined> {
  const info = await statOrUndefined(filePath);
  if (info === undefined) return undefined;
  return { entry: await readRegistrationFile(filePath), mtimeMs: info.mtimeMs };
}

async function removeStaleIfUnchanged(
  filePath: string,
  snapshot: RegistryFileSnapshot,
): Promise<void> {
  const current = await statOrUndefined(filePath);
  if (current === undefined || current.mtimeMs !== snapshot.mtimeMs) return;
  const entry = await readRegistrationFile(filePath);
  if (entry?.heartbeatAt !== snapshot.entry?.heartbeatAt) return;
  await unlinkIfPresent(filePath);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    const handle = await open(tmpPath, 'w', REGISTRY_FILE_MODE);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlinkIfPresent(tmpPath);
    throw error;
  }
}

async function registryNames(registryDir: string): Promise<string[]> {
  try {
    return await readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index] as T);
    }
  });
  await Promise.all(workers);
}

export function createCrossSessionRegistry(
  options: CrossSessionRegistryOptions = {},
): ICrossSessionRegistry {
  const registryDir =
    options.registryDir ??
    resolveCrossSessionRegistryDir(process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code'));
  const now = options.now ?? Date.now;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? CROSS_SESSION_HEARTBEAT_INTERVAL_MS;
  const offlineAfterMs = options.offlineAfterMs ?? CROSS_SESSION_OFFLINE_AFTER_MS;
  const staleAfterMs = options.staleAfterMs ?? CROSS_SESSION_STALE_AFTER_MS;

  const isStale = (entry: CrossSessionRegistration): boolean =>
    now() - entry.heartbeatAt > staleAfterMs;

  const statusOf = (entry: CrossSessionRegistration): 'live' | 'offline' =>
    now() - entry.heartbeatAt > offlineAfterMs ? 'offline' : 'live';

  const removeStaleTempFiles = async (names: readonly string[]): Promise<void> => {
    await mapWithConcurrency(
      names.filter(isTempRegistryFile),
      REGISTRY_FS_CONCURRENCY,
      async (name) => {
        const filePath = join(registryDir, name);
        let info: Stats;
        try {
          info = await stat(filePath);
        } catch {
          return;
        }
        if (!info.isFile() || now() - info.mtimeMs <= TEMP_FILE_MAX_AGE_MS) return;
        await unlinkIfPresent(filePath);
      },
    );
  };

  const collectStaleOrLive = async (
    names: readonly string[],
    onLive: (entry: CrossSessionRegistration) => void,
  ): Promise<void> => {
    await mapWithConcurrency(
      names.filter(isRegistryFile),
      REGISTRY_FS_CONCURRENCY,
      async (name) => {
        const filePath = join(registryDir, name);
        const snapshot = await snapshotRegistryFile(filePath);
        if (snapshot === undefined) return;
        const entry = snapshot.entry;
        if (entry === undefined || isStale(entry)) {
          await removeStaleIfUnchanged(filePath, snapshot);
          return;
        }
        onLive(entry);
      },
    );
  };

  return {
    statusOf,

    async register(input) {
      await mkdir(registryDir, { recursive: true, mode: REGISTRY_DIR_MODE });
      const filePath = filePathFor(registryDir, input.sessionId);
      const state = {
        title: input.title,
        socketPath: input.socketPath,
        token: input.token,
        released: false,
      };
      let writeChain: Promise<void> = Promise.resolve();

      const write = async (): Promise<void> => {
        if (state.released) return;
        await writeFileAtomic(
          filePath,
          encode({
            sessionId: input.sessionId,
            socketPath: state.socketPath,
            token: state.token,
            pid: input.pid ?? process.pid,
            heartbeatAt: now(),
            startedAt: input.startedAt ?? now(),
            ...(state.title !== undefined ? { title: state.title } : {}),
          }),
        );
      };

      const enqueueWrite = (): Promise<void> => {
        const next = writeChain.then(write);
        writeChain = next.catch(() => {});
        return next;
      };

      let heartbeatQueued = false;

      const enqueueHeartbeat = (): void => {
        if (heartbeatQueued || state.released) return;
        heartbeatQueued = true;
        const next = writeChain.then(async () => {
          heartbeatQueued = false;
          await write();
        });
        writeChain = next.catch(() => {});
      };

      await enqueueWrite();

      const timer = setInterval(enqueueHeartbeat, heartbeatIntervalMs);
      timer.unref();

      return {
        sessionId: input.sessionId,
        async update(patch) {
          if (state.released) return;
          if (patch.title !== undefined) state.title = patch.title;
          if (patch.socketPath !== undefined) state.socketPath = patch.socketPath;
          if (patch.token !== undefined) state.token = patch.token;
          await enqueueWrite();
        },
        async release() {
          if (state.released) return;
          state.released = true;
          clearInterval(timer);
          await writeChain;
          await unlinkIfPresent(filePath);
        },
      };
    },

    async listLive() {
      const names = await registryNames(registryDir);
      await removeStaleTempFiles(names);
      const live: CrossSessionRegistration[] = [];
      await collectStaleOrLive(names, (entry) => {
        live.push(entry);
      });
      live.sort((a, b) => a.startedAt - b.startedAt);
      return live;
    },

    async get(sessionId) {
      const names = await registryNames(registryDir).catch(() => []);
      await removeStaleTempFiles(names);
      const filePath = filePathFor(registryDir, sessionId);
      const snapshot = await snapshotRegistryFile(filePath);
      if (snapshot === undefined) return undefined;
      const entry = snapshot.entry;
      if (entry === undefined) return undefined;
      if (entry.sessionId !== sessionId || isStale(entry)) {
        await removeStaleIfUnchanged(filePath, snapshot);
        return undefined;
      }
      return entry;
    },

    async sweepStale() {
      const names = await registryNames(registryDir);
      await removeStaleTempFiles(names);
      await collectStaleOrLive(names, () => {});
    },
  };
}
