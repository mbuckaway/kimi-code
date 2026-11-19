import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
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

export function resolveCrossSessionRegistryDir(homeDir: string): string {
  return join(homeDir, 'messaging', 'registry');
}

export function safeSessionFileName(sessionId: string): string {
  return ENGINE_SESSION_ID.test(sessionId)
    ? sessionId
    : Buffer.from(sessionId, 'utf8').toString('hex');
}

function filePathFor(registryDir: string, sessionId: string): string {
  return join(registryDir, `${safeSessionFileName(sessionId)}${REGISTRY_FILE_SUFFIX}`);
}

function isRegistryFile(name: string): boolean {
  return name.endsWith(REGISTRY_FILE_SUFFIX);
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

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlinkIfPresent(tmpPath);
    }
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

  const removeStale = async (filePath: string): Promise<void> => {
    await unlinkIfPresent(filePath);
  };

  return {
    statusOf,

    async register(input) {
      await mkdir(registryDir, { recursive: true });
      const filePath = filePathFor(registryDir, input.sessionId);
      const state = {
        title: input.title,
        socketPath: input.socketPath,
        token: input.token,
        released: false,
      };
      let inflightWrites = 0;
      let onWritesDrained: (() => void) | undefined;

      const write = async (): Promise<void> => {
        if (state.released) return;
        inflightWrites += 1;
        try {
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
        } finally {
          inflightWrites -= 1;
          if (inflightWrites === 0) onWritesDrained?.();
        }
      };

      await write();

      const timer = setInterval(() => {
        void write().catch(() => {});
      }, heartbeatIntervalMs);
      timer.unref();

      return {
        sessionId: input.sessionId,
        async update(patch) {
          if (state.released) return;
          if (patch.title !== undefined) state.title = patch.title;
          if (patch.socketPath !== undefined) state.socketPath = patch.socketPath;
          if (patch.token !== undefined) state.token = patch.token;
          await write();
        },
        async release() {
          if (state.released) return;
          state.released = true;
          clearInterval(timer);
          if (inflightWrites > 0) {
            await new Promise<void>((resolve) => {
              onWritesDrained = resolve;
            });
          }
          await unlinkIfPresent(filePath);
        },
      };
    },

    async listLive() {
      const names = await registryNames(registryDir);
      const live: CrossSessionRegistration[] = [];
      await Promise.all(
        names.filter(isRegistryFile).map(async (name) => {
          const filePath = join(registryDir, name);
          const entry = await readRegistrationFile(filePath);
          if (entry === undefined || isStale(entry)) {
            await removeStale(filePath);
            return;
          }
          live.push(entry);
        }),
      );
      live.sort((a, b) => a.startedAt - b.startedAt);
      return live;
    },

    async get(sessionId) {
      const filePath = filePathFor(registryDir, sessionId);
      const entry = await readRegistrationFile(filePath);
      if (entry === undefined) return undefined;
      if (entry.sessionId !== sessionId || isStale(entry)) {
        await removeStale(filePath);
        return undefined;
      }
      return entry;
    },

    async sweepStale() {
      const names = await registryNames(registryDir);
      await Promise.all(
        names.filter(isRegistryFile).map(async (name) => {
          const filePath = join(registryDir, name);
          const entry = await readRegistrationFile(filePath);
          if (entry === undefined || isStale(entry)) {
            await removeStale(filePath);
          }
        }),
      );
    },
  };
}
