import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event, type IWaitUntil } from '#/_base/event';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionMessagingService,
  type CrossSessionInboundMessage,
  type CrossSessionReceiveResult,
  type AgentInbox,
  type AgentInboxMessage,
} from '#/features/messaging/messaging';
import { CROSS_SESSION_MESSAGING_FLAG_ID } from '#/features/messaging/flag';
import {
  CROSS_SESSION_OFFLINE_AFTER_MS,
  CROSS_SESSION_STALE_AFTER_MS,
  createCrossSessionRegistry,
  resolveCrossSessionRegistryDir,
  safeSessionFileName,
  type CrossSessionRegistration,
} from '#/features/messaging/crossSession/crossSessionRegistry';
import {
  CROSS_SESSION_IDLE_TIMEOUT_MS,
  CROSS_SESSION_MAX_FRAME_BYTES,
  CROSS_SESSION_SOCKET_DIR_ENV,
  CrossSessionFrameDecoder,
  ackFromReceiveResult,
  encodeCrossSessionFrame,
  resolveCrossSessionSocketDir,
  resolveCrossSessionSocketPath,
  resolveCrossSessionInboxSocketPath,
  sendCrossSessionFrame,
  startCrossSessionInbox,
  type CrossSessionAckFrame,
  type CrossSessionInboundFrame,
  type CrossSessionWireFrame,
} from '#/features/messaging/crossSession/crossSessionTransport';
import {
  CrossSessionMessagingService,
  ICrossSessionMessagingService,
  type CrossSessionSendResult,
} from '#/features/messaging/crossSession/crossSessionMessaging';
import {
  CrossSessionInboxHost,
} from '#/features/messaging/crossSession/crossSessionInboxHost';

import { stubFlag } from '../../app/flag/stubs';

const SESSION_A = 'session_11111111-1111-4111-8111-111111111111';
const SESSION_B = 'session_22222222-2222-4222-8222-222222222222';
const SESSION_C = 'session_33333333-3333-4333-8333-333333333333';

type Handler = (...args: unknown[]) => void;

const netFake = vi.hoisted(() => {
  class FakeEmitter {
    private readonly handlers = new Map<string, Set<Handler>>();

    on(event: string, handler: Handler): this {
      const set = this.handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      this.handlers.set(event, set);
      return this;
    }

    once(event: string, handler: Handler): this {
      const wrapper = (...args: unknown[]): void => {
        this.off(event, wrapper);
        handler(...args);
      };
      return this.on(event, wrapper);
    }

    off(event: string, handler: Handler): this {
      this.handlers.get(event)?.delete(handler);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
      return true;
    }

    listenerCount(event: string): number {
      return this.handlers.get(event)?.size ?? 0;
    }
  }

  class FakeSocket extends FakeEmitter {
    peer: FakeSocket | undefined;
    destroyed = false;
    unrefed = false;
    timeoutMs: number | undefined;

    write(chunk: unknown): boolean {
      const text = String(chunk);
      const peer = this.peer;
      queueMicrotask(() => {
        if (peer !== undefined && !peer.destroyed) peer.emit('data', Buffer.from(text));
      });
      return true;
    }

    end(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('end');
      queueMicrotask(() => {
        this.emit('close');
        const peer = this.peer;
        if (peer !== undefined && !peer.destroyed) {
          peer.destroyed = true;
          peer.emit('close');
        }
      });
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      queueMicrotask(() => {
        this.emit('close');
        const peer = this.peer;
        if (peer !== undefined && !peer.destroyed) {
          peer.destroyed = true;
          peer.emit('close');
        }
      });
    }

    setTimeout(ms: number): this {
      this.timeoutMs = ms;
      return this;
    }

    unref(): this {
      this.unrefed = true;
      return this;
    }
  }

  const servers = new Map<string, (socket: FakeSocket) => void>();
  const refused = new Set<string>();
  const serverSockets: FakeSocket[] = [];
  let listenFailures = 0;
  let serverCreates = 0;
  let serverUnrefs = 0;

  function createServer(onConnection: (socket: FakeSocket) => void) {
    serverCreates += 1;
    const server = new FakeEmitter() as FakeEmitter & {
      listen(path: string, cb?: () => void): void;
      close(cb?: () => void): void;
      unref(): void;
    };
    server.listen = (path, cb) => {
      if (listenFailures > 0) {
        listenFailures -= 1;
        throw new Error('listen EADDRINUSE: address already in use');
      }
      servers.set(path, onConnection);
      cb?.();
    };
    server.close = (cb) => {
      for (const [path, handler] of [...servers]) {
        if (handler === onConnection) servers.delete(path);
      }
      cb?.();
    };
    server.unref = () => {
      serverUnrefs += 1;
    };
    return server;
  }

  function createConnection(path: string): FakeSocket {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    server.peer = client;
    if (refused.has(path)) {
      queueMicrotask(() => client.emit('error', new Error('connect ECONNREFUSED')));
      return client;
    }
    const accept = servers.get(path);
    if (accept === undefined) {
      queueMicrotask(() => client.emit('error', new Error('connect ECONNREFUSED')));
      return client;
    }
    queueMicrotask(() => {
      serverSockets.push(server);
      accept(server);
    });
    return client;
  }

  return {
    createServer,
    createConnection,
    servers,
    refused,
    serverSockets,
    failNextListen(count = 1): void {
      listenFailures = count;
    },
    serverCreateCount(): number {
      return serverCreates;
    },
    serverUnrefCount(): number {
      return serverUnrefs;
    },
    reset(): void {
      servers.clear();
      refused.clear();
      serverSockets.length = 0;
      listenFailures = 0;
      serverCreates = 0;
      serverUnrefs = 0;
    },
  };
});

vi.mock('node:net', () => ({
  createServer: netFake.createServer,
  createConnection: netFake.createConnection,
}));

const fsReadHook = vi.hoisted(() => ({
  afterRead: undefined as ((path: string) => Promise<void> | void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: unknown[]) => {
      const result = await (actual.readFile as (...inner: unknown[]) => Promise<unknown>)(
        ...args,
      );
      await fsReadHook.afterRead?.(String(args[0]));
      return result;
    }) as typeof actual.readFile,
  };
});

const realSetImmediate = setImmediate;

function tick(ticks = 4): Promise<void> {
  let promise = Promise.resolve();
  for (let i = 0; i < ticks; i++) promise = promise.then(() => new Promise<void>((r) => realSetImmediate(r)));
  return promise;
}

function makeAccessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

interface FakeMessaging extends ISessionMessagingService {
  readonly received: CrossSessionInboundMessage[];
  readonly inbox: AgentInboxMessage[];
}

const DEFAULT_RECEIVE_RESULT: CrossSessionReceiveResult = {
  kind: 'delivered',
  delivery: 'newTurn',
  truncated: false,
};

function fakeMessaging(result: CrossSessionReceiveResult = DEFAULT_RECEIVE_RESULT): FakeMessaging {
  const received: CrossSessionInboundMessage[] = [];
  const inbox: AgentInboxMessage[] = [];
  const service = {
    _serviceBrand: undefined,
    received,
    inbox,
    async receiveCrossSession(input: CrossSessionInboundMessage): Promise<CrossSessionReceiveResult> {
      received.push(input);
      if (result.kind === 'delivered') {
        inbox.push({
          id: input.messageId,
          from: input.fromSessionId,
          fromLabel: input.fromSessionTitle,
          fromSessionId: input.fromSessionId,
          fromSessionLabel: input.fromSessionTitle,
          message: input.message,
          delivery: result.delivery,
          truncated: result.truncated,
        });
      }
      return result;
    },
    async listMessages(): Promise<AgentInbox> {
      return { messages: [...inbox], pending: 0 };
    },
    async sendMessage(): Promise<never> {
      throw new Error('not implemented');
    },
    listHeldCrossSessionMessages: () => [],
    async replyMessage(): Promise<never> {
      throw new Error('not implemented');
    },
    async broadcastMessage(): Promise<never> {
      throw new Error('not implemented');
    },
    async stopAgent(): Promise<never> {
      throw new Error('not implemented');
    },
    async interruptAgent(): Promise<never> {
      throw new Error('not implemented');
    },
    async listAgents(): Promise<never> {
      throw new Error('not implemented');
    },
    async rosterInstructions(): Promise<undefined> {
      return undefined;
    },
  } as unknown as FakeMessaging;
  return service;
}

function sessionHandle(input: {
  readonly sessionId: string;
  readonly title?: string;
  readonly loopState?: 'idle' | 'running';
  readonly messaging?: ISessionMessagingService;
  readonly withMain?: boolean;
}): ISessionScopeHandle {
  const messaging = input.messaging ?? fakeMessaging();
  const loop = {
    status: () => ({ state: input.loopState ?? 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as unknown as IAgentLoopService;
  const agentHandle = {
    id: MAIN_AGENT_ID,
    kind: 'agent',
    accessor: makeAccessor([[IAgentLoopService, loop]]),
    dispose: () => {},
  };
  const lifecycle = {
    handleOf: (agentId: string) =>
      agentId === MAIN_AGENT_ID && input.withMain !== false ? agentHandle : undefined,
  } as unknown as IAgentLifecycleService;
  const metadata = {
    read: async () => ({
      id: input.sessionId,
      title: input.title,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    }),
  } as unknown as ISessionMetadata;
  return {
    id: input.sessionId,
    kind: 'session',
    accessor: makeAccessor([
      [ISessionMessagingService, messaging],
      [IAgentLifecycleService, lifecycle],
      [ISessionMetadata, metadata],
    ]),
    dispose: () => {},
  } as unknown as ISessionScopeHandle;
}

function fakeSessions(handles: readonly ISessionScopeHandle[]): ISessionManager {
  const byId = new Map(handles.map((handle) => [handle.id, handle]));
  return {
    _serviceBrand: undefined,
    onDidCreateSession: Event.None,
    onWillCloseSession: Event.None,
    onDidCloseSession: Event.None,
    onDidArchiveSession: Event.None,
    list: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    create: async () => {
      throw new Error('not implemented');
    },
    resume: async () => undefined,
    status: async () => undefined,
    whenResumeSettled: async () => {},
    withLifecycleSerialization: async (
      _id: string,
      work: (unguarded: {
        archive(): Promise<void>;
        restore(): Promise<undefined>;
      }) => Promise<unknown>,
    ) => work({ archive: async () => {}, restore: async () => undefined }),
    close: async () => {},
    archive: async () => {},
    restore: async () => undefined,
    delete: async () => {},
    fork: async () => {
      throw new Error('not implemented');
    },
    createChild: async () => {
      throw new Error('not implemented');
    },
  } as unknown as ISessionManager;
}

function bootstrapStub(homeDir: string): IBootstrapService {
  return { homeDir } as unknown as IBootstrapService;
}

function enabledFlag(id: string): boolean {
  return id === CROSS_SESSION_MESSAGING_FLAG_ID;
}

async function waitForAcks(socket: { on(event: string, handler: Handler): unknown }): Promise<[CrossSessionAckFrame]> {
  const ack = await new Promise<CrossSessionAckFrame>((resolve) => {
    const decoder = new CrossSessionFrameDecoder();
    socket.on('data', (chunk: unknown) => {
      const frames = decoder.push(chunk instanceof Uint8Array ? chunk : String(chunk));
      for (const frame of frames) {
        if (frame.type === 'ack') resolve(frame);
      }
    });
    socket.on('close', () => {
      resolve({ type: 'ack', messageId: '', kind: 'error', truncated: false, error: 'closed' });
    });
  });
  return [ack];
}

async function startTestInbox(input: {
  readonly socketPath: string;
  readonly token: string;
  readonly handle?: (
    sessionId: string,
    frame: CrossSessionInboundFrame,
  ) => Promise<CrossSessionAckFrame>;
  readonly idleTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxConnections?: number;
}): Promise<Awaited<ReturnType<typeof startCrossSessionInbox>>> {
  return startCrossSessionInbox({
    socketPath: input.socketPath,
    token: input.token,
    handle:
      input.handle ??
      (async (_sessionId, frame) =>
        ackFromReceiveResult(frame.messageId, { kind: 'delivered', delivery: 'newTurn', truncated: false })),
    idleTimeoutMs: input.idleTimeoutMs,
    maxFrameBytes: input.maxFrameBytes,
    maxConnections: input.maxConnections,
  });
}

describe('crossSessionRegistry', () => {
  let root: string;
  let now: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    fsReadHook.afterRead = undefined;
    root = await mkdtemp(join(tmpdir(), 'cross-session-registry-'));
    now = 1_000;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function registry(options: { heartbeatIntervalMs?: number } = {}) {
    return createCrossSessionRegistry({
      registryDir: join(root, 'messaging', 'registry'),
      now: () => now,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
    });
  }

  it('safeSessionFileName_keepsEngineIdsAndHexEncodesOtherValues', () => {
    expect(safeSessionFileName(SESSION_A)).toBe(SESSION_A);
    expect(safeSessionFileName('user/../id')).toBe(
      Buffer.from('user/../id', 'utf8').toString('hex'),
    );
  });

  it('register_writesOneJsonFileWithTheExpectedShape', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      title: 'Alpha',
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
      pid: 4242,
      startedAt: 900,
    });

    const dir = join(root, 'messaging', 'registry');
    const names = await readdir(dir);
    expect(names).toEqual([`${SESSION_A}.json`]);
    const stored = JSON.parse(await readFile(join(dir, names[0]!), 'utf8')) as CrossSessionRegistration;
    expect(stored).toMatchObject({
      sessionId: SESSION_A,
      title: 'Alpha',
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
      pid: 4242,
      heartbeatAt: 1_000,
      startedAt: 900,
    });
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
    await handle.release();
  });

  it('register_createsTheRegistryDirectoryAndFileWithOwnerOnlyPermissions', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });

    const dir = join(root, 'messaging', 'registry');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${SESSION_A}.json`))).mode & 0o777).toBe(0o600);
    await handle.release();
  });

  it('register_hexEncodesUnsafeSessionIdsInTheFileName', async () => {
    const unsafe = 'not a safe session id';
    const handle = await registry().register({
      sessionId: unsafe,
      socketPath: '/tmp/socket.sock',
      token: 'token',
    });
    const dir = join(root, 'messaging', 'registry');
    expect(await readdir(dir)).toEqual([`${Buffer.from(unsafe, 'utf8').toString('hex')}.json`]);
    const listed = await registry().listLive();
    expect(listed.map((entry) => entry.sessionId)).toEqual([unsafe]);
    await handle.release();
  });

  it('heartbeat_refreshesHeartbeatAtWithoutChangingStartedAt', async () => {
    const handle = await registry({ heartbeatIntervalMs: 500 }).register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
      startedAt: 900,
    });
    now = 2_500;
    await vi.advanceTimersByTimeAsync(500);
    const readStored = async () => (await registry().listLive())[0];
    let stored = await readStored();
    for (let attempt = 0; attempt < 200 && stored?.heartbeatAt !== 2_500; attempt += 1) {
      await tick(1);
      stored = await readStored();
    }
    expect(stored?.heartbeatAt).toBe(2_500);
    expect(stored?.startedAt).toBe(900);
    await handle.release();
  });

  it('release_stopsTheHeartbeatAndUnlinksTheFile', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    await handle.release();
    const dir = join(root, 'messaging', 'registry');
    expect(await readdir(dir)).toEqual([]);
    now = 9_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await readdir(dir)).toEqual([]);
  });

  it('update_rewritesMutableFields', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    await handle.update({ title: 'Renamed', token: 'token-b' });
    const stored = await registry().get(SESSION_A);
    expect(stored?.title).toBe('Renamed');
    expect(stored?.token).toBe('token-b');
    await handle.release();
  });

  it('listLive_filtersByHeartbeatAgeAndRemovesStaleFiles', async () => {
    const first = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;
    const listed = await registry().listLive();
    expect(listed).toEqual([]);
    expect(await readdir(join(root, 'messaging', 'registry'))).toEqual([]);
    await first.release();
  });

  it('listLive_keepsAnEntryThatWasRefreshedDuringTheStaleScan', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    const dir = join(root, 'messaging', 'registry');
    const filePath = join(dir, `${SESSION_A}.json`);
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;

    let fired = false;
    fsReadHook.afterRead = async (path) => {
      if (fired || path !== filePath) return;
      fired = true;
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as CrossSessionRegistration;
      await writeFile(
        filePath,
        JSON.stringify({ ...stored, heartbeatAt: now, socketPath: '/tmp/refreshed.sock' }),
      );
    };

    expect(await registry().listLive()).toEqual([]);
    expect(await readdir(dir)).toContain(`${SESSION_A}.json`);
    const listed = await registry().listLive();
    expect(listed.map((entry) => entry.sessionId)).toEqual([SESSION_A]);
    expect(listed[0]?.socketPath).toBe('/tmp/refreshed.sock');
    await handle.release();
  });

  it('sweepStale_keepsAnEntryThatWasRefreshedDuringTheStaleScan', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    const dir = join(root, 'messaging', 'registry');
    const filePath = join(dir, `${SESSION_A}.json`);
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;

    let fired = false;
    fsReadHook.afterRead = async (path) => {
      if (fired || path !== filePath) return;
      fired = true;
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as CrossSessionRegistration;
      await writeFile(filePath, JSON.stringify({ ...stored, heartbeatAt: now }));
    };

    await registry().sweepStale();
    expect(await readdir(dir)).toContain(`${SESSION_A}.json`);
    expect((await registry().get(SESSION_A))?.heartbeatAt).toBe(now);
    await handle.release();
  });

  it('get_keepsAnEntryThatWasRefreshedDuringTheStaleCheck', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    const dir = join(root, 'messaging', 'registry');
    const filePath = join(dir, `${SESSION_A}.json`);
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;

    let fired = false;
    fsReadHook.afterRead = async (path) => {
      if (fired || path !== filePath) return;
      fired = true;
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as CrossSessionRegistration;
      await writeFile(filePath, JSON.stringify({ ...stored, heartbeatAt: now }));
    };

    expect(await registry().get(SESSION_A)).toBeUndefined();
    expect(await readdir(dir)).toContain(`${SESSION_A}.json`);
    expect((await registry().get(SESSION_A))?.heartbeatAt).toBe(now);
    await handle.release();
  });

  it('listLive_keepsFreshEntriesEvenWhenThePidIsNotAlive', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
      pid: 999_999,
    });
    const listed = await registry().listLive();
    expect(listed.map((entry) => entry.sessionId)).toEqual([SESSION_A]);
    await handle.release();
  });

  it('statusOf_reportsOfflineOnceTheHeartbeatAgesPastTheOfflineWindow', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    const fresh = await registry().get(SESSION_A);
    expect(fresh !== undefined && registry().statusOf(fresh)).toBe('live');
    now = 1_000 + CROSS_SESSION_OFFLINE_AFTER_MS + 1;
    const aging = await registry().get(SESSION_A);
    expect(aging !== undefined && registry().statusOf(aging)).toBe('offline');
    await handle.release();
  });

  it('get_returnsUndefinedForUnknownAndStaleEntries', async () => {
    expect(await registry().get(SESSION_A)).toBeUndefined();
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;
    expect(await registry().get(SESSION_A)).toBeUndefined();
    await handle.release();
  });

  it('sweepStale_removesMalformedAndStaleFiles', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'malformed.json'), 'not json');
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    now = 1_000 + CROSS_SESSION_STALE_AFTER_MS + 1;
    await registry().sweepStale();
    expect(await readdir(dir)).toEqual([]);
    await handle.release();
  });

  it('decode_ignoresFilesWithTheWrongShape', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'wrong.json'), JSON.stringify({ sessionId: 1, socketPath: [] }));
    expect(await registry().listLive()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('listLive_sortsByStartedAt', async () => {
    const late = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
      startedAt: 300,
    });
    const early = await registry().register({
      sessionId: SESSION_B,
      socketPath: '/tmp/socket-b.sock',
      token: 'token-b',
      startedAt: 200,
    });
    const listed = await registry().listLive();
    expect(listed.map((entry) => entry.sessionId)).toEqual([SESSION_B, SESSION_A]);
    await late.release();
    await early.release();
  });

  it('update_ignoresWritesAfterReleaseAndAcceptsSocketPatches', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    await handle.update({ socketPath: '/tmp/socket-b.sock' });
    expect((await registry().get(SESSION_A))?.socketPath).toBe('/tmp/socket-b.sock');
    await handle.release();
    await handle.update({ title: 'ignored' });
    await handle.release();
    expect(await registry().get(SESSION_A)).toBeUndefined();
  });

  it('release_waitsForAnInflightWriteBeforeUnlinking', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    const updating = handle.update({ title: 'inflight' });
    const releasing = handle.release();
    await Promise.all([updating, releasing]);
    expect(await registry().get(SESSION_A)).toBeUndefined();
  });

  it('registry_usesTheConfiguredHomeWhenNoDirectoryIsGiven', () => {
    const env = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/configured';
    try {
      createCrossSessionRegistry({ now: () => 0 });
    } finally {
      if (env === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = env;
    }
    const defaulted = createCrossSessionRegistry({ now: () => 0 });
    expect(
      defaulted.statusOf({
        sessionId: SESSION_A,
        socketPath: '/tmp/socket.sock',
        token: 'token',
        pid: 1,
        heartbeatAt: 0,
        startedAt: 0,
      }),
    ).toBe('live');
  });

  it('sweepStale_keepsFreshEntries', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    await registry().sweepStale();
    expect((await registry().listLive()).map((entry) => entry.sessionId)).toEqual([SESSION_A]);
    await handle.release();
  });

  it('listLive_rejectsWhenAStaleEntryCannotBeRemoved', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(join(dir, 'broken.json'), { recursive: true });
    await expect(registry().listLive()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('concurrentUpdates_serialiseSoTheLastUpdateWins', async () => {
    const handle = await registry().register({
      sessionId: SESSION_A,
      socketPath: '/tmp/socket-a.sock',
      token: 'token-a',
    });
    await Promise.all([
      handle.update({ title: 'one' }),
      handle.update({ title: 'two' }),
      handle.update({ title: 'three' }),
    ]);
    expect((await registry().get(SESSION_A))?.title).toBe('three');
    const names = await readdir(join(root, 'messaging', 'registry'));
    expect(names.filter((name) => name.includes('.json.tmp.'))).toEqual([]);
    await handle.release();
  });

  it('register_removesTheTempFileWhenTheRenameFails', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, `${SESSION_A}.json`), { recursive: true });

    await expect(
      registry().register({
        sessionId: SESSION_A,
        socketPath: '/tmp/socket-a.sock',
        token: 'token-a',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY|EPERM)$/) });

    expect(await readdir(dir)).toEqual([`${SESSION_A}.json`]);
  });

  it('sweepStale_removesTempFilesOlderThanAMinute', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    const staleTemp = join(dir, `${SESSION_A}.json.tmp.1.abcd`);
    const freshTemp = join(dir, `${SESSION_A}.json.tmp.1.fresh`);
    await writeFile(staleTemp, '{}');
    await writeFile(freshTemp, '{}');
    await utimes(staleTemp, new Date(0), new Date(0));
    now = 1_000 + 60_001;

    await registry().sweepStale();

    const remaining = await readdir(dir);
    expect(remaining).not.toContain(`${SESSION_A}.json.tmp.1.abcd`);
    expect(remaining).toContain(`${SESSION_A}.json.tmp.1.fresh`);
  });

  it('listLive_removesTempFilesOlderThanAMinute', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    const staleTemp = join(dir, `${SESSION_A}.json.tmp.2.abcd`);
    await writeFile(staleTemp, '{}');
    await utimes(staleTemp, new Date(0), new Date(0));
    now = 1_000 + 60_001;

    expect(await registry().listLive()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('get_removesTempFilesOlderThanAMinute', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(dir, { recursive: true });
    const staleTemp = join(dir, `${SESSION_A}.json.tmp.3.abcd`);
    await writeFile(staleTemp, '{}');
    await utimes(staleTemp, new Date(0), new Date(0));
    now = 1_000 + 60_001;

    expect(await registry().get(SESSION_B)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it('listLive_surfacesUnreadableDirectories', async () => {
    const dir = join(root, 'messaging', 'registry');
    await mkdir(join(root, 'messaging'), { recursive: true });
    await writeFile(dir, 'not a directory');
    await expect(registry().listLive()).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('resolveCrossSessionRegistryDir_usesTheMessagingRegistrySubdirectory', () => {
    expect(resolveCrossSessionRegistryDir('/home/example')).toBe(
      join('/home/example', 'messaging', 'registry'),
    );
  });
});

describe('crossSessionTransport', () => {
  let root: string;
  let previousSocketDir: string | undefined;

  beforeEach(async () => {
    netFake.reset();
    root = await mkdtemp(join(tmpdir(), 'cross-session-transport-'));
    previousSocketDir = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] = join(root, 'sockets');
  });

  afterEach(async () => {
    if (previousSocketDir === undefined) delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    else process.env[CROSS_SESSION_SOCKET_DIR_ENV] = previousSocketDir;
    netFake.reset();
    await rm(root, { recursive: true, force: true });
  });

  it('resolveCrossSessionSocketDir_shortensTheDefaultPathToTheUidDirectory', () => {
    expect(resolveCrossSessionSocketDir({ uid: 4321, tmpDir: '/temp' })).toBe(
      join('/temp', 'kimi-socks-4321'),
    );
    expect(resolveCrossSessionSocketPath(SESSION_A, { uid: 4321, tmpDir: '/temp' })).toBe(
      join('/temp', 'kimi-socks-4321', `${SESSION_A}.sock`),
    );
    expect(resolveCrossSessionSocketPath('unsafe/id', { uid: 4321, tmpDir: '/temp' })).toBe(
      join('/temp', 'kimi-socks-4321', `${safeSessionFileName('unsafe/id')}.sock`),
    );
    expect(resolveCrossSessionSocketDir({ tmpDir: '/temp' })).toMatch(/kimi-socks-\d+$/);
    expect(resolveCrossSessionSocketDir({ uid: 77 })).toBe(join(tmpdir(), 'kimi-socks-77'));
  });

  it('resolveCrossSessionInboxSocketPath_buildsTheSharedProcessSocketName', () => {
    expect(resolveCrossSessionInboxSocketPath({ uid: 4321, tmpDir: '/temp', pid: 99 })).toBe(
      join('/temp', 'kimi-socks-4321', 'inbox-99.sock'),
    );
    expect(
      resolveCrossSessionInboxSocketPath({ uid: 4321, tmpDir: '/temp', pid: 99, suffix: 'abcd' }),
    ).toBe(join('/temp', 'kimi-socks-4321', 'inbox-99-abcd.sock'));
    expect(resolveCrossSessionInboxSocketPath({ uid: 77 })).toMatch(/inbox-\d+\.sock$/);
  });

  it('frameDecoder_ignoresMalformedLines', () => {
    const decoder = new CrossSessionFrameDecoder();
    const frames = decoder.push(
      `${JSON.stringify({ type: 'auth', token: 't' })}\nnot json\n${JSON.stringify({ type: 'ack', messageId: 'm', kind: 'delivered', truncated: false })}\n`,
    );
    expect(frames.map((frame) => frame.type)).toEqual(['auth', 'ack']);
  });

  it('frameDecoder_dropsNonObjectAndUntypedLines', () => {
    const decoder = new CrossSessionFrameDecoder();
    const frames = decoder.push(
      [
        'null',
        '[]',
        '42',
        '"text"',
        JSON.stringify({ type: 5 }),
        JSON.stringify([{ type: 'auth', token: 't' }]),
        JSON.stringify({ type: 'auth', token: 't' }),
        '',
      ].join('\n') + '\n',
    );
    expect(frames).toEqual([{ type: 'auth', token: 't' }]);
    expect(decoder.droppedLines).toBe(6);
  });

  it('frameDecoder_countsMalformedJsonLines', () => {
    const decoder = new CrossSessionFrameDecoder();
    expect(decoder.push('not json\n')).toEqual([]);
    expect(decoder.droppedLines).toBe(1);
  });

  it('frameDecoder_preservesMultiByteCharactersAcrossChunks', () => {
    const decoder = new CrossSessionFrameDecoder();
    const line = Buffer.from(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'こんにちは世界',
      }),
      'utf8',
    );
    const cut = line.indexOf(Buffer.from('こんにちは', 'utf8')) + 1;
    expect(decoder.push(line.subarray(0, cut))).toEqual([]);
    const frames = decoder.push(line.subarray(cut));
    expect(frames).toHaveLength(1);
    expect((frames[0] as CrossSessionInboundFrame).message).toBe('こんにちは世界');
    expect(decoder.droppedLines).toBe(0);
  });

  it('frameDecoder_flagsLinesOverTheFrameLimit', () => {
    const decoder = new CrossSessionFrameDecoder({ maxFrameBytes: 32 });
    expect(decoder.push('x'.repeat(33))).toEqual([]);
    expect(decoder.overflowed).toBe(true);
    expect(decoder.push('x\n')).toEqual([]);
  });

  it('frameDecoder_acceptsALineAtTheFrameLimit', () => {
    const decoder = new CrossSessionFrameDecoder({ maxFrameBytes: 32 });
    const line = JSON.stringify({ type: 'ping' });
    expect(line.length).toBeLessThanOrEqual(32);
    expect(decoder.push(`${line}\n`)).toEqual([{ type: 'ping' }]);
    expect(decoder.overflowed).toBe(false);
  });

  it('ackFromReceiveResult_mapsEveryReceiveVariant', () => {
    expect(
      ackFromReceiveResult('m1', { kind: 'delivered', delivery: 'steered', truncated: true }),
    ).toEqual({ type: 'ack', messageId: 'm1', kind: 'delivered', delivery: 'steered', truncated: true });
    expect(ackFromReceiveResult('m2', { kind: 'held', truncated: false })).toEqual({
      type: 'ack',
      messageId: 'm2',
      kind: 'held',
      truncated: false,
    });
    expect(
      ackFromReceiveResult('m3', { kind: 'refused', reason: 'policy', truncated: true }),
    ).toEqual({ type: 'ack', messageId: 'm3', kind: 'refused', reason: 'policy', truncated: true });
  });

  it('server_rejectsAMissingToken', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'wrong' }));
    const [ack] = await waitForAcks(socket);
    expect(ack.kind).toBe('error');
    expect(ack.error).toContain('unauthorized');
    await server.close();
  });

  it('server_requiresAuthenticationBeforeAMessage', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    );
    const [ack] = await waitForAcks(socket);
    expect(ack.kind).toBe('error');
    expect(ack.error).toContain('expected auth first');
    await server.close();
  });

  it('server_deliversAuthenticatedFramesAndRepliesWithAnAck', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const received: CrossSessionInboundFrame[] = [];
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        received.push(frame);
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B, title: 'Beta' },
        message: 'hello',
        inReplyTo: 'prev',
      }),
    );
    const [ack] = await waitForAcks(socket);
    expect(received).toEqual([
      {
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B, title: 'Beta' },
        message: 'hello',
        inReplyTo: 'prev',
      },
    ]);
    expect(ack).toEqual({
      type: 'ack',
      messageId: 'm1',
      kind: 'delivered',
      delivery: 'newTurn',
      truncated: false,
    });
    await server.close();
  });

  it('server_reportsHandlerFailuresAsErrorAcks', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async () => {
        throw new Error('delivery exploded');
      },
    });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    );
    const [ack] = await waitForAcks(socket);
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'error', error: 'delivery exploded' });
    await server.close();
  });

  it('server_rejectsMalformedMessageFramesAfterAuthentication', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(`${JSON.stringify({ type: 'message', messageId: '', from: {}, message: 1 })}\n`);
    const [ack] = await waitForAcks(socket);
    expect(ack.kind).toBe('error');
    expect(ack.error).toContain('invalid message frame');
    await server.close();
  });

  it('server_rejectsUnknownFrameTypesAfterAuthentication', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(`${JSON.stringify({ type: 'bogus' })}\n`);
    const [ack] = await waitForAcks(socket);
    expect(ack.kind).toBe('error');
    expect(ack.error).toContain('unknown frame type');
    await server.close();
  });

  it('server_ignoresNonObjectLinesBeforeAndAfterAuthentication', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const received: CrossSessionInboundFrame[] = [];
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        received.push(frame);
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    const socket = netFake.createConnection(socketPath);
    socket.write('null\n[]\n42\n"text"\n');
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write('null\n[]\n42\n"text"\n');
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    );
    const [ack] = await waitForAcks(socket);
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'delivered' });
    expect(received).toHaveLength(1);
    await server.close();
  });

  it('server_destroysTheConnectionWhenALineExceedsTheFrameLimit', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });

    const beforeAuth = netFake.createConnection(socketPath);
    beforeAuth.write('x'.repeat(CROSS_SESSION_MAX_FRAME_BYTES + 1));
    await tick();
    expect(netFake.serverSockets[0]?.destroyed).toBe(true);

    const afterAuth = netFake.createConnection(socketPath);
    afterAuth.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    afterAuth.write(`${'y'.repeat(CROSS_SESSION_MAX_FRAME_BYTES + 1)}\n`);
    await tick();
    expect(netFake.serverSockets[1]?.destroyed).toBe(true);
    await server.close();
  });

  it('server_unrefsAcceptedSocketsAndArmsTheIdleTimeout', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    netFake.createConnection(socketPath);
    await tick();
    const accepted = netFake.serverSockets[0]!;
    expect(accepted.unrefed).toBe(true);
    expect(accepted.timeoutMs).toBe(CROSS_SESSION_IDLE_TIMEOUT_MS);
    accepted.emit('timeout');
    await tick();
    expect(accepted.destroyed).toBe(true);
    await server.close();
  });

  it('server_destroysIdleConnectionsThroughTheConfiguredTimeout', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret', idleTimeoutMs: 0 });
    netFake.createConnection(socketPath);
    await tick();
    expect(netFake.serverSockets[0]?.timeoutMs).toBeUndefined();
    await server.close();
  });

  it('server_capsConcurrentConnections', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const received: CrossSessionInboundFrame[] = [];
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      maxConnections: 1,
      handle: async (_sessionId, frame) => {
        received.push(frame);
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    const first = netFake.createConnection(socketPath);
    await tick();
    const second = netFake.createConnection(socketPath);
    await tick();
    expect(second.destroyed).toBe(true);

    first.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    first.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    );
    const [ack] = await waitForAcks(first);
    expect(ack).toMatchObject({ kind: 'delivered' });
    expect(received).toHaveLength(1);
    await server.close();
  });

  it('server_deliversMultiByteMessagesSplitAcrossSocketChunks', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const received: CrossSessionInboundFrame[] = [];
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        received.push(frame);
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    netFake.createConnection(socketPath);
    await tick();
    const accepted = netFake.serverSockets[0]!;
    const wire = Buffer.from(
      encodeCrossSessionFrame({ type: 'auth', token: 'secret' }) +
        encodeCrossSessionFrame({
          type: 'message',
          sessionId: SESSION_A,
          messageId: 'm1',
          from: { sessionId: SESSION_B },
          message: 'こんにちは世界',
        }),
      'utf8',
    );
    const cut = wire.indexOf(Buffer.from('こんにちは', 'utf8')) + 1;
    accepted.emit('data', wire.subarray(0, cut));
    accepted.emit('data', wire.subarray(cut));
    await tick();
    expect(received).toHaveLength(1);
    expect(received[0]?.message).toBe('こんにちは世界');
    await server.close();
  });

  it('close_waitsForInflightHandlersBeforeDestroyingConnections', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        await handlerGate;
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    );
    await tick();
    const acks = waitForAcks(socket);
    const closing = server.close();
    await tick();
    expect(netFake.serverSockets[0]?.destroyed).toBe(false);
    releaseHandler();
    const [ack] = await acks;
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'delivered' });
    await closing;
    expect(netFake.serverSockets[0]?.destroyed).toBe(true);
  });

  it('start_repairsAPreexistingWorldWritableSocketDirectory', async () => {
    const socketDir = join(root, 'sockets');
    await mkdir(socketDir, { recursive: true });
    await chmod(socketDir, 0o777);
    const server = await startTestInbox({ socketPath: join(socketDir, 'inbox.sock'), token: 'secret' });
    expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
    await server.close();
  });

  it('start_refusesToBindInsideANonDirectorySocketPath', async () => {
    const blocker = join(root, 'sockets');
    await writeFile(blocker, 'not a directory');
    await expect(
      startTestInbox({ socketPath: join(blocker, 'inbox.sock'), token: 'secret' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) });
  });

  it('start_removesAStaleSocketFileBeforeBinding', async () => {
    const socketDir = join(root, 'sockets');
    await mkdir(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'inbox.sock');
    await writeFile(socketPath, 'stale');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    await expect(readFile(socketPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await server.close();
  });

  it('start_refusesToBindThroughASymlink', async () => {
    const socketDir = join(root, 'sockets');
    await mkdir(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'inbox.sock');
    await symlink(join(root, 'target.sock'), socketPath);
    await expect(startTestInbox({ socketPath, token: 'secret' })).rejects.toThrow(
      /refusing to use symlink/,
    );
  });

  it('start_createsTheSocketDirectoryWithOwnerOnlyPermissions', async () => {
    const socketPath = join(root, 'nested', 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const info = await import('node:fs/promises').then((fs) => fs.stat(join(root, 'nested', 'sockets')));
    expect(info.mode & 0o777).toBe(0o700);
    await server.close();
  });

  it('start_unrefsTheListeningServerAndStillCloses', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    expect(netFake.serverUnrefCount()).toBe(1);
    expect(netFake.servers.has(socketPath)).toBe(true);
    await server.close();
    expect(netFake.servers.has(socketPath)).toBe(false);
  });

  it('send_authenticatesSendsAndReturnsTheAck', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const received: CrossSessionInboundFrame[] = [];
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        received.push(frame);
        return ackFromReceiveResult(frame.messageId, { kind: 'held', truncated: true });
      },
    });
    const ack = await sendCrossSessionFrame(socketPath, 'secret', {
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_A, title: 'Alpha' },
      message: 'hello',
    });
    expect(ack).toEqual({ type: 'ack', messageId: 'm1', kind: 'held', truncated: true });
    expect(received[0]?.message).toBe('hello');
    await server.close();
  });

  it('send_rejectsWhenNoServerIsListening', async () => {
    await expect(
      sendCrossSessionFrame(join(root, 'sockets', 'missing.sock'), 'secret', {
        sessionId: SESSION_B,
        messageId: 'm1',
        from: { sessionId: SESSION_A },
        message: 'hello',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('send_rejectsWhenTheSignalIsAlreadyAborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      sendCrossSessionFrame(
        join(root, 'sockets', 'missing.sock'),
        'secret',
        { sessionId: SESSION_B, messageId: 'm1', from: { sessionId: SESSION_A }, message: 'hello' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('cancelled');
  });

  it('close_isIdempotentAndStopsAcceptingConnections', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    await server.close();
    await server.close();
    await expect(
      sendCrossSessionFrame(socketPath, 'secret', {
        sessionId: SESSION_B,
        messageId: 'm1',
        from: { sessionId: SESSION_A },
        message: 'hello',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('resolveCrossSessionSocketDir_fallsBackToUidZeroWhenGetuidIsMissing', () => {
    const env = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    const original = process.getuid;
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      expect(resolveCrossSessionSocketDir({ tmpDir: '/temp' })).toMatch(/kimi-socks-/);
      expect(resolveCrossSessionSocketDir()).toBe(join(tmpdir(), 'kimi-socks-0'));
    } finally {
      Object.defineProperty(process, 'getuid', { value: original, configurable: true });
      if (env !== undefined) process.env[CROSS_SESSION_SOCKET_DIR_ENV] = env;
    }
  });

  it('frameDecoder_skipsEmptyLines', () => {
    const decoder = new CrossSessionFrameDecoder();
    expect(decoder.push('\n\n')).toEqual([]);
  });

  it.each([
    ['empty message id', { sessionId: SESSION_A, messageId: '', from: { sessionId: SESSION_B }, message: 'x' }],
    ['non-string message', { sessionId: SESSION_A, messageId: 'm1', from: { sessionId: SESSION_B }, message: 1 }],
    ['missing peer', { sessionId: SESSION_A, messageId: 'm1', from: null, message: 'x' }],
    ['empty peer id', { sessionId: SESSION_A, messageId: 'm1', from: { sessionId: '' }, message: 'x' }],
    ['non-string title', { sessionId: SESSION_A, messageId: 'm1', from: { sessionId: SESSION_B, title: 5 }, message: 'x' }],
    ['non-string reply id', { sessionId: SESSION_A, messageId: 'm1', from: { sessionId: SESSION_B }, message: 'x', inReplyTo: 5 }],
    ['missing session id', { messageId: 'm1', from: { sessionId: SESSION_B }, message: 'x' }],
    ['empty session id', { sessionId: '', messageId: 'm1', from: { sessionId: SESSION_B }, message: 'x' }],
  ])('server_rejectsFramesWith%s', async (_label, frame) => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(`${JSON.stringify({ type: 'message', ...frame })}\n`);
    const [ack] = await waitForAcks(socket);
    expect(ack).toMatchObject({ kind: 'error', error: 'invalid message frame' });
    await server.close();
  });

  it('send_forwardsReplyIdsAndClosesWhenThePeerCloses', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    let received: CrossSessionInboundFrame | undefined;
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        received = frame;
        return ackFromReceiveResult(frame.messageId, { kind: 'held', truncated: false });
      },
    });
    await sendCrossSessionFrame(socketPath, 'secret', {
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_A },
      message: 'hello',
      inReplyTo: 'prev',
    });
    expect(received?.inReplyTo).toBe('prev');
    await server.close();
  });

  it('send_timesOutWhenThePeerNeverAcks', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async () => new Promise<CrossSessionAckFrame>(() => {}),
    });
    await expect(
      sendCrossSessionFrame(
        socketPath,
        'secret',
        { sessionId: SESSION_B, messageId: 'm1', from: { sessionId: SESSION_A }, message: 'hello' },
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow(/timed out/);
    await server.close();
  });

  it('send_abortsAnInFlightRequest', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async () => new Promise<CrossSessionAckFrame>(() => {}),
    });
    const controller = new AbortController();
    const pending = sendCrossSessionFrame(
      socketPath,
      'secret',
      { sessionId: SESSION_B, messageId: 'm1', from: { sessionId: SESSION_A }, message: 'hello' },
      { signal: controller.signal },
    );
    controller.abort(new Error('stop now'));
    await expect(pending).rejects.toThrow('stop now');
    await server.close();
  });

  it('close_removesALeakedSocketFileAndDropsLiveConnections', async () => {
    const socketDir = join(root, 'sockets');
    await mkdir(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    await writeFile(socketPath, 'leaked');
    await server.close();
    await expect(readFile(socketPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('server_rejectsNonStringTokens', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(`${JSON.stringify({ type: 'auth', token: 5 })}\n`);
    const [ack] = await waitForAcks(socket);
    expect(ack).toMatchObject({ kind: 'error', error: 'unauthorized' });
    await server.close();
  });

  it('server_ignoresFramesAfterCompletion', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'wrong' }));
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    const [ack] = await waitForAcks(socket);
    expect(ack).toMatchObject({ kind: 'error', error: 'unauthorized' });
    await server.close();
  });

  it('server_settlesOnlyTheFirstOfTwoMessages', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    let calls = 0;
    const server = await startTestInbox({
      socketPath,
      token: 'secret',
      handle: async (_sessionId, frame) => {
        calls += 1;
        return ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'newTurn',
          truncated: false,
        });
      },
    });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'one',
      }),
    );
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_A,
        messageId: 'm2',
        from: { sessionId: SESSION_B },
        message: 'two',
      }),
    );
    const [ack] = await waitForAcks(socket);
    expect(ack.messageId).toBe('m1');
    await tick(20);
    expect(calls).toBe(2);
    await server.close();
  });

  it('send_succeedsWithoutATimeout', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const ack = await sendCrossSessionFrame(
      socketPath,
      'secret',
      { sessionId: SESSION_B, messageId: 'm1', from: { sessionId: SESSION_A }, message: 'hello' },
      { timeoutMs: 0 },
    );
    expect(ack.kind).toBe('delivered');
    await server.close();
  });

  it('close_reportsUnremovablePaths', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    await mkdir(socketPath, { recursive: true });
    await expect(server.close()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('server_survivesClientSocketErrors', async () => {
    const socketPath = join(root, 'sockets', 'inbox.sock');
    const server = await startTestInbox({ socketPath, token: 'secret' });
    const socket = netFake.createConnection(socketPath);
    socket.write(encodeCrossSessionFrame({ type: 'auth', token: 'secret' }));
    await tick();
    netFake.serverSockets[0]?.emit('error', new Error('client reset'));
    await server.close();
    expect(netFake.serverSockets).toHaveLength(1);
  });
});

describe('crossSessionMessaging', () => {
  let root: string;
  let previousSocketDir: string | undefined;

  beforeEach(async () => {
    netFake.reset();
    root = await mkdtemp(join(tmpdir(), 'cross-session-messaging-'));
    previousSocketDir = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] = join(root, 'sockets');
  });

  afterEach(async () => {
    if (previousSocketDir === undefined) delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    else process.env[CROSS_SESSION_SOCKET_DIR_ENV] = previousSocketDir;
    netFake.reset();
    await rm(root, { recursive: true, force: true });
  });

  function service(sessions: ISessionManager, enabled = true) {
    return new CrossSessionMessagingService(
      sessions,
      stubFlag((id: string) => (enabled ? enabledFlag(id) : false)),
      bootstrapStub(root),
    );
  }

  it('listSessions_mergesInProcessAndRegistryEntriesAndExcludesTheCaller', async () => {
    const messaging = service(
      fakeSessions([
        sessionHandle({ sessionId: SESSION_A, title: 'Alpha', loopState: 'running' }),
        sessionHandle({ sessionId: SESSION_B, title: 'Beta', loopState: 'idle' }),
      ]),
    );
    const registry = createCrossSessionRegistry({
      registryDir: resolveCrossSessionRegistryDir(root),
    });
    const handle = await registry.register({
      sessionId: SESSION_C,
      title: 'Gamma',
      socketPath: '/tmp/c.sock',
      token: 'token-c',
    });
    const rows = await messaging.listSessions(SESSION_A);
    expect(rows).toEqual([
      { sessionId: SESSION_B, title: 'Beta', status: 'idle' },
      { sessionId: SESSION_C, title: 'Gamma', status: 'live' },
    ]);
    await handle.release();
  });

  it('listSessions_prefersTheInProcessRowOverTheRegistryRow', async () => {
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, title: 'Beta', loopState: 'running' })]));
    const registry = createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) });
    const handle = await registry.register({
      sessionId: SESSION_B,
      title: 'Stale registry title',
      socketPath: '/tmp/b.sock',
      token: 'token-b',
    });
    const rows = await messaging.listSessions(SESSION_A);
    expect(rows).toEqual([{ sessionId: SESSION_B, title: 'Beta', status: 'running' }]);
    await handle.release();
  });

  it('listSessions_returnsAnEmptyListWhenTheFlagIsOff', async () => {
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B })]), false);
    expect(await messaging.listSessions(SESSION_A)).toEqual([]);
  });

  it('send_refusesWhenTheFlagIsOff', async () => {
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B })]), false);
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'm1', message: 'hello' }),
    ).toEqual({ kind: 'refused', reason: 'policy', truncated: false });
  });

  it('send_refusesSelfTargets', async () => {
    const messaging = service(fakeSessions([]));
    expect(
      await messaging.send(SESSION_A, SESSION_A, { messageId: 'm1', message: 'hello' }),
    ).toEqual({ kind: 'refused', reason: 'self', truncated: false });
  });

  it('send_shortCircuitsToTheInProcessMessagingService', async () => {
    const target = fakeMessaging();
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    const result = await messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
      fromSessionTitle: 'Alpha',
      inReplyTo: 'prev',
    });
    expect(result).toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });
    expect(target.received).toHaveLength(1);
    expect(target.received[0]).toMatchObject({
      fromSessionId: SESSION_A,
      fromSessionTitle: 'Alpha',
      messageId: 'm1',
      message: 'hello',
      inReplyTo: 'prev',
    });
    const inbox = await target.listMessages(MAIN_AGENT_ID);
    expect(inbox.messages[0]).toMatchObject({ fromSessionId: SESSION_A, message: 'hello' });
  });

  it('send_usesTheRegistrySocketWhenTheTargetIsNotInProcess', async () => {
    const socketPath = join(root, 'sockets', 'b.sock');
    const inbox = await startTestInbox({
      socketPath,
      token: 'token-b',
      handle: async (_sessionId, frame) =>
        ackFromReceiveResult(frame.messageId, {
          kind: 'delivered',
          delivery: 'resumed',
          truncated: false,
        }),
    });
    const registry = createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) });
    const handle = await registry.register({
      sessionId: SESSION_B,
      socketPath,
      token: 'token-b',
    });
    const messaging = service(fakeSessions([]));
    const result = await messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
      fromSessionTitle: 'Alpha',
    });
    expect(result).toEqual({ kind: 'delivered', delivery: 'resumed', truncated: false });
    await handle.release();
    await inbox.close();
  });

  it('send_reportsOfflineWhenNoRegistryEntryExists', async () => {
    const messaging = service(fakeSessions([]));
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'm1', message: 'hello' }),
    ).toEqual({ kind: 'offline' });
  });

  it('send_deliversWhenThePeerRegistersDuringTheBindWindow', async () => {
    const socketPath = join(root, 'sockets', 'b.sock');
    const inbox = await startTestInbox({ socketPath, token: 'token-b' });
    const registry = createCrossSessionRegistry({
      registryDir: resolveCrossSessionRegistryDir(root),
    });
    const messaging = service(fakeSessions([]));
    const pending = messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const handle = await registry.register({
      sessionId: SESSION_B,
      socketPath,
      token: 'token-b',
    });
    await expect(pending).resolves.toEqual({
      kind: 'delivered',
      delivery: 'newTurn',
      truncated: false,
    });
    await handle.release();
    await inbox.close();
  });

  it('send_deliversInProcessWhenThePeerGoesLiveDuringTheBindWindow', async () => {
    const live = new Map<string, ISessionScopeHandle>();
    const sessions = {
      ...fakeSessions([]),
      get: (id: string) => live.get(id),
      list: () => [...live.values()],
    } as unknown as ISessionManager;
    const target = fakeMessaging();
    const messaging = service(sessions);
    const pending = messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    live.set(SESSION_B, sessionHandle({ sessionId: SESSION_B, messaging: target }));
    await expect(pending).resolves.toEqual({
      kind: 'delivered',
      delivery: 'newTurn',
      truncated: false,
    });
    expect(target.received).toHaveLength(1);
    expect(target.received[0]).toMatchObject({
      fromSessionId: SESSION_A,
      messageId: 'm1',
      message: 'hello',
    });
  });

  it('send_stopsTheBindWindowRetryOnAbort', async () => {
    const messaging = service(fakeSessions([]));
    const controller = new AbortController();
    const pending = messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow('stopped');
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort(new Error('stopped'));
    await rejection;
  });

  it('send_stopsTheBindWindowRetryWhenAbortedBeforeTheDelay', async () => {
    const controller = new AbortController();
    const sessions = {
      ...fakeSessions([]),
      get: () => {
        controller.abort(new Error('stopped'));
        return undefined;
      },
    } as unknown as ISessionManager;
    const messaging = service(sessions);
    await expect(
      messaging.send(SESSION_A, SESSION_B, {
        messageId: 'm1',
        message: 'hello',
        signal: controller.signal,
      }),
    ).rejects.toThrow('stopped');
  });

  it('send_reportsOfflineAfterTheBoundedBindWindow', async () => {
    vi.useFakeTimers();
    try {
      const messaging = service(fakeSessions([]));
      const pending = messaging.send(SESSION_A, SESSION_B, {
        messageId: 'm1',
        message: 'hello',
      });
      for (let step = 0; step < 14; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await expect(pending).resolves.toEqual({ kind: 'offline' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('send_mapsTransportFailuresToErrorResults', async () => {
    const registry = createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) });
    const handle = await registry.register({
      sessionId: SESSION_B,
      socketPath: join(root, 'sockets', 'missing.sock'),
      token: 'token-b',
    });
    const messaging = service(fakeSessions([]));
    const result = await messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
    });
    expect(result.kind).toBe('error');
    expect((result as { error: string }).error).toContain('ECONNREFUSED');
    await handle.release();
  });

  it('send_returnsAnErrorResultWhenTheInProcessReceiverThrows', async () => {
    const target = fakeMessaging();
    (target as unknown as { receiveCrossSession: () => Promise<never> }).receiveCrossSession =
      async () => {
        throw new Error('receiver failed');
      };
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'm1', message: 'hello' }),
    ).toEqual({ kind: 'error', error: 'receiver failed' });
  });

  it('send_propagatesAbortSignals', async () => {
    const messaging = service(fakeSessions([]));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      messaging.send(SESSION_A, SESSION_B, {
        messageId: 'm1',
        message: 'hello',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('receive_routesFramesToTheTargetAndReturnsTheMappedAck', async () => {
    const target = fakeMessaging({ kind: 'held', truncated: true });
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    const ack = await messaging.receive(SESSION_B, {
      type: 'message',
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_A, title: 'Alpha' },
      message: 'hello',
      inReplyTo: 'prev',
    });
    expect(ack).toEqual({ type: 'ack', messageId: 'm1', kind: 'held', truncated: true });
    expect(target.received[0]).toMatchObject({
      fromSessionId: SESSION_A,
      fromSessionTitle: 'Alpha',
      messageId: 'm1',
      message: 'hello',
      inReplyTo: 'prev',
    });
  });

  it('receive_returnsAnErrorAckWhenTheSessionIsNotLive', async () => {
    const messaging = service(fakeSessions([]));
    const ack = await messaging.receive(SESSION_B, {
      type: 'message',
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_A },
      message: 'hello',
    });
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'error', error: 'session not live' });
  });

  it('receive_returnsAnErrorAckWhenTheReceiverThrows', async () => {
    const target = fakeMessaging();
    (target as unknown as { receiveCrossSession: () => Promise<never> }).receiveCrossSession =
      async () => {
        throw new Error('receiver failed');
      };
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    const ack = await messaging.receive(SESSION_B, {
      type: 'message',
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_A },
      message: 'hello',
    });
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'error', error: 'receiver failed' });
  });

  it('send_mapsHeldRefusedAndFallbackAcks', async () => {
    const socketPath = join(root, 'sockets', 'b.sock');
    const inbox = await startTestInbox({
      socketPath,
      token: 'token-b',
      handle: async (_sessionId, frame) => {
        switch (frame.messageId) {
          case 'held':
            return { type: 'ack', messageId: 'held', kind: 'held', truncated: true };
          case 'refused':
            return {
              type: 'ack',
              messageId: 'refused',
              kind: 'refused',
              reason: 'policy',
              truncated: true,
            };
          case 'refused-default':
            return { type: 'ack', messageId: 'refused-default', kind: 'refused', truncated: false };
          case 'error':
            return { type: 'ack', messageId: 'error', kind: 'error', truncated: false };
          default:
            return { type: 'ack', messageId: frame.messageId, kind: 'delivered', truncated: false };
        }
      },
    });
    const registry = createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) });
    const handle = await registry.register({ sessionId: SESSION_B, socketPath, token: 'token-b' });
    const messaging = service(fakeSessions([]));

    expect(
      await messaging.send(SESSION_A, SESSION_B, {
        messageId: 'held',
        message: 'hello',
        inReplyTo: 'prev',
      }),
    ).toEqual({ kind: 'held', truncated: true });
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'refused', message: 'hello' }),
    ).toEqual({ kind: 'refused', reason: 'policy', truncated: true });
    expect(
      await messaging.send(SESSION_A, SESSION_B, {
        messageId: 'refused-default',
        message: 'hello',
      }),
    ).toEqual({ kind: 'refused', reason: 'policy', truncated: false });
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'error', message: 'hello' }),
    ).toEqual({ kind: 'error', error: 'cross-session delivery failed' });
    expect(
      await messaging.send(SESSION_A, SESSION_B, {
        messageId: 'delivered-default',
        message: 'hello',
      }),
    ).toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });

    await handle.release();
    await inbox.close();
  });

  it('send_convertsNonErrorFailuresToStrings', async () => {
    const target = fakeMessaging();
    (target as unknown as { receiveCrossSession: () => Promise<never> }).receiveCrossSession =
      async () => {
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw 'plain failure';
      };
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    expect(
      await messaging.send(SESSION_A, SESSION_B, { messageId: 'm1', message: 'hello' }),
    ).toEqual({ kind: 'error', error: 'plain failure' });
  });

  it('send_propagatesAnAbortDuringInProcessDelivery', async () => {
    const controller = new AbortController();
    const target = fakeMessaging();
    (target as unknown as { receiveCrossSession: () => Promise<never> }).receiveCrossSession =
      async () => {
        controller.abort(new Error('stopped'));
        throw controller.signal.reason;
      };
    const messaging = service(fakeSessions([sessionHandle({ sessionId: SESSION_B, messaging: target })]));
    await expect(
      messaging.send(SESSION_A, SESSION_B, {
        messageId: 'm1',
        message: 'hello',
        signal: controller.signal,
      }),
    ).rejects.toThrow('stopped');
  });

  it('send_propagatesAnAbortDuringSocketDelivery', async () => {
    const socketPath = join(root, 'sockets', 'b.sock');
    const inbox = await startTestInbox({
      socketPath,
      token: 'token-b',
      handle: async () => new Promise<CrossSessionAckFrame>(() => {}),
    });
    const registry = createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) });
    const handle = await registry.register({ sessionId: SESSION_B, socketPath, token: 'token-b' });
    const messaging = service(fakeSessions([]));
    const controller = new AbortController();
    const pending = messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello',
      signal: controller.signal,
    });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    await handle.release();
    await inbox.close();
  });

  it('listSessions_reportsIdleAndOfflineFallbacks', async () => {
    const broken = {
      id: SESSION_B,
      kind: 'session',
      accessor: makeAccessor([]),
      dispose: () => {},
    } as unknown as ISessionScopeHandle;
    const idle = sessionHandle({ sessionId: SESSION_C, withMain: false });
    const messaging = service(fakeSessions([broken, idle]));

    const registryDir = resolveCrossSessionRegistryDir(root);
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, `${SESSION_A}.json`),
      JSON.stringify({
        sessionId: 'session_44444444-4444-4444-8444-444444444444',
        title: 'Offline',
        socketPath: '/tmp/offline.sock',
        token: 'token',
        pid: 1,
        heartbeatAt: Date.now() - 60_000,
        startedAt: 1,
      }),
    );
    await writeFile(
      join(registryDir, `${SESSION_B}.json`),
      JSON.stringify({
        sessionId: 'session_55555555-5555-4555-8555-555555555555',
        socketPath: '/tmp/anonymous.sock',
        token: 'token',
        pid: 1,
        heartbeatAt: Date.now(),
        startedAt: 2,
      }),
    );

    const rows = await messaging.listSessions(SESSION_A);
    expect(rows).toEqual([
      { sessionId: SESSION_B, status: 'idle' },
      { sessionId: SESSION_C, status: 'idle' },
      {
        sessionId: 'session_44444444-4444-4444-8444-444444444444',
        title: 'Offline',
        status: 'offline',
      },
      {
        sessionId: 'session_55555555-5555-4555-8555-555555555555',
        status: 'live',
      },
    ]);
  });
});

interface HostEvents {
  readonly create: Emitter<{ sessionId: string; handle: ISessionScopeHandle; source: 'startup' } & IWaitUntil>;
  readonly willClose: Emitter<{ sessionId: string; handle: ISessionScopeHandle; reason: 'exit' } & IWaitUntil>;
  readonly didClose: Emitter<{ sessionId: string }>;
  readonly didArchive: Emitter<{ sessionId: string }>;
  readonly waits: Promise<unknown>[];
  readonly fireCreate: (id: string, handle: ISessionScopeHandle) => void;
  readonly fireWillClose: (id: string, handle: ISessionScopeHandle) => void;
}

function hostSessions(initial: readonly ISessionScopeHandle[] = []): {
  readonly manager: ISessionManager;
  readonly events: HostEvents;
} {
  const byId = new Map(initial.map((handle) => [handle.id, handle]));
  const create = new Emitter<{ sessionId: string; handle: ISessionScopeHandle; source: 'startup' } & IWaitUntil>();
  const willClose = new Emitter<{ sessionId: string; handle: ISessionScopeHandle; reason: 'exit' } & IWaitUntil>();
  const didClose = new Emitter<{ sessionId: string }>();
  const didArchive = new Emitter<{ sessionId: string }>();
  const waits: Promise<unknown>[] = [];
  const manager = {
    _serviceBrand: undefined,
    onDidCreateSession: create.event,
    onWillCloseSession: willClose.event,
    onDidCloseSession: didClose.event,
    onDidArchiveSession: didArchive.event,
    list: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    create: async () => {
      throw new Error('not implemented');
    },
    resume: async () => undefined,
    status: async () => undefined,
    whenResumeSettled: async () => {},
    withLifecycleSerialization: async (
      _id: string,
      work: (unguarded: {
        archive(): Promise<void>;
        restore(): Promise<undefined>;
      }) => Promise<unknown>,
    ) => work({ archive: async () => {}, restore: async () => undefined }),
    close: async () => {},
    archive: async () => {},
    restore: async () => undefined,
    delete: async () => {},
    fork: async () => {
      throw new Error('not implemented');
    },
    createChild: async () => {
      throw new Error('not implemented');
    },
  } as unknown as ISessionManager;
  const register = (id: string, handle: ISessionScopeHandle): void => {
    byId.set(id, handle);
  };
  const fireCreate = (id: string, handle: ISessionScopeHandle): void => {
    create.fire({ sessionId: id, handle, source: 'startup', waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never);
  };
  const fireWillClose = (id: string, handle: ISessionScopeHandle): void => {
    willClose.fire({ sessionId: id, handle, reason: 'exit', waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never);
  };
  return {
    manager,
    events: { create, willClose, didClose, didArchive, waits, fireCreate, fireWillClose },
  };
}

function fakeCrossSessionMessaging(): ICrossSessionMessagingService & {
  readonly received: CrossSessionInboundFrame[];
  readonly targets: string[];
} {
  const received: CrossSessionInboundFrame[] = [];
  const targets: string[] = [];
  return {
    _serviceBrand: undefined,
    received,
    targets,
    async listSessions(): Promise<readonly never[]> {
      return [];
    },
    async send(): Promise<CrossSessionSendResult> {
      return { kind: 'offline' };
    },
    async receive(sessionId: string, frame: CrossSessionInboundFrame): Promise<CrossSessionAckFrame> {
      targets.push(sessionId);
      received.push(frame);
      return ackFromReceiveResult(frame.messageId, {
        kind: 'delivered',
        delivery: 'newTurn',
        truncated: false,
      });
    },
  } as unknown as ICrossSessionMessagingService & {
    readonly received: CrossSessionInboundFrame[];
    readonly targets: string[];
  };
}

describe('crossSessionInboxHost', () => {
  let root: string;
  let previousSocketDir: string | undefined;

  beforeEach(async () => {
    netFake.reset();
    root = await mkdtemp(join(tmpdir(), 'cross-session-host-'));
    previousSocketDir = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] = join(root, 'sockets');
  });

  afterEach(async () => {
    if (previousSocketDir === undefined) delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    else process.env[CROSS_SESSION_SOCKET_DIR_ENV] = previousSocketDir;
    netFake.reset();
    await rm(root, { recursive: true, force: true });
  });

  async function liveRegistry(): Promise<readonly CrossSessionRegistration[]> {
    return createCrossSessionRegistry({ registryDir: resolveCrossSessionRegistryDir(root) }).listLive();
  }

  it('doesNothingWhenTheFlagIsOff', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(false),
      fakeCrossSessionMessaging(),
    );
    expect(host.enabled).toBe(false);
    expect(sessions.events.create.listenerCount).toBe(0);
    sessions.events.fireCreate(SESSION_A, sessionHandle({ sessionId: SESSION_A }));
    await tick();
    expect(await liveRegistry()).toEqual([]);
    expect(host.boundSessions()).toEqual([]);
  });

  it('bindsOnCreateRegistersAndServesFrames', async () => {
    const sessions = hostSessions();
    const messaging = fakeCrossSessionMessaging();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      messaging,
    );
    sessions.events.fireCreate(SESSION_A, sessionHandle({ sessionId: SESSION_A, title: 'Alpha' }));
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    const listed = await liveRegistry();
    expect(listed.map((entry) => entry.sessionId)).toEqual([SESSION_A]);
    expect(listed[0]?.title).toBe('Alpha');
    expect(host.boundSessions()).toEqual([SESSION_A]);
    const [entry] = listed;
    const ack = await sendCrossSessionFrame(entry!.socketPath, entry!.token, {
      sessionId: SESSION_A,
      messageId: 'm1',
      from: { sessionId: SESSION_B, title: 'Beta' },
      message: 'hello',
    });
    expect(ack).toMatchObject({ messageId: 'm1', kind: 'delivered' });
    expect(messaging.received[0]).toMatchObject({ messageId: 'm1', message: 'hello' });
  });

  it('bindsExistingSessionsAtConstruction', async () => {
    const handle = sessionHandle({ sessionId: SESSION_A });
    const sessions = hostSessions([handle]);
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    expect((await liveRegistry()).map((entry) => entry.sessionId)).toEqual([SESSION_A]);
  });

  it('willCloseReleasesTheSocketAndRegistryEntry', async () => {
    const handle = sessionHandle({ sessionId: SESSION_A });
    const sessions = hostSessions([handle]);
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    const [entry] = await liveRegistry();
    sessions.events.fireWillClose(SESSION_A, handle);
    await Promise.all(sessions.events.waits);
    expect(host.boundSessions()).toEqual([]);
    expect(await liveRegistry()).toEqual([]);
    await expect(
      sendCrossSessionFrame(entry!.socketPath, entry!.token, {
        sessionId: SESSION_A,
        messageId: 'm1',
        from: { sessionId: SESSION_B },
        message: 'hello',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('didCloseAndDidArchiveReleaseTheSession', async () => {
    const first = sessionHandle({ sessionId: SESSION_A });
    const second = sessionHandle({ sessionId: SESSION_B });
    const sessions = hostSessions([first, second]);
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect([...host.boundSessions()].toSorted()).toEqual([SESSION_A, SESSION_B].toSorted());
    });
    sessions.events.didClose.fire({ sessionId: SESSION_A });
    sessions.events.didArchive.fire({ sessionId: SESSION_B });
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([]);
    });
    expect(await liveRegistry()).toEqual([]);
  });

  it('bindsEachSessionOnlyOnce', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    const handle = sessionHandle({ sessionId: SESSION_A });
    sessions.events.fireCreate(SESSION_A, handle);
    sessions.events.fireCreate(SESSION_A, handle);
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    await host.bindSession(SESSION_A, handle);
    expect(host.boundSessions()).toEqual([SESSION_A]);
    expect((await liveRegistry()).length).toBe(1);
  });

  it('twoBoundSessionsShareOneServerAndSocket', async () => {
    const sessions = hostSessions([
      sessionHandle({ sessionId: SESSION_A, title: 'Alpha' }),
      sessionHandle({ sessionId: SESSION_B, title: 'Beta' }),
    ]);
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect([...host.boundSessions()].toSorted()).toEqual([SESSION_A, SESSION_B].toSorted());
    });
    const listed = await liveRegistry();
    expect(listed.map((entry) => entry.sessionId).toSorted()).toEqual(
      [SESSION_A, SESSION_B].toSorted(),
    );
    expect(new Set(listed.map((entry) => entry.socketPath)).size).toBe(1);
    expect(new Set(listed.map((entry) => entry.token)).size).toBe(1);
    expect(netFake.servers.size).toBe(1);
    expect(netFake.serverCreateCount()).toBe(1);
    host.dispose();
  });

  it('routesFramesByTheSessionIdInTheFrame', async () => {
    const sessions = hostSessions([
      sessionHandle({ sessionId: SESSION_A }),
      sessionHandle({ sessionId: SESSION_B }),
    ]);
    const messaging = fakeCrossSessionMessaging();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      messaging,
    );
    await vi.waitFor(() => {
      expect([...host.boundSessions()].toSorted()).toEqual([SESSION_A, SESSION_B].toSorted());
    });
    const entry = (await liveRegistry()).find((row) => row.sessionId === SESSION_B)!;
    const ack = await sendCrossSessionFrame(entry.socketPath, entry.token, {
      sessionId: SESSION_B,
      messageId: 'm-b',
      from: { sessionId: SESSION_C },
      message: 'for beta',
    });
    expect(ack).toMatchObject({ messageId: 'm-b', kind: 'delivered' });
    expect(messaging.targets).toEqual([SESSION_B]);
    expect(messaging.received[0]).toMatchObject({ sessionId: SESSION_B, message: 'for beta' });
    host.dispose();
  });

  it('acksAnUnknownSessionIdWithAnError', async () => {
    const sessions = hostSessions([sessionHandle({ sessionId: SESSION_A })]);
    const messaging = fakeCrossSessionMessaging();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      messaging,
    );
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    const [entry] = await liveRegistry();
    const ack = await sendCrossSessionFrame(entry!.socketPath, entry!.token, {
      sessionId: SESSION_C,
      messageId: 'm-c',
      from: { sessionId: SESSION_B },
      message: 'nobody',
    });
    expect(ack).toMatchObject({ messageId: 'm-c', kind: 'error', error: 'unknown session' });
    expect(messaging.targets).toEqual([]);
    host.dispose();
  });

  it('keepsTheSharedServerUntilTheLastSessionReleases', async () => {
    const sessionHandles = new Map<string, ISessionScopeHandle>([
      [SESSION_A, sessionHandle({ sessionId: SESSION_A })],
      [SESSION_B, sessionHandle({ sessionId: SESSION_B })],
    ]);
    const sessions = hostSessions([...sessionHandles.values()]);
    const messaging = fakeCrossSessionMessaging();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      messaging,
    );
    await vi.waitFor(() => {
      expect([...host.boundSessions()].toSorted()).toEqual([SESSION_A, SESSION_B].toSorted());
    });
    expect(netFake.servers.size).toBe(1);
    const originalToken = (await liveRegistry()).find(
      (entry) => entry.sessionId === SESSION_B,
    )!.token;

    await host.releaseSession(SESSION_A);
    expect(host.boundSessions()).toEqual([SESSION_B]);
    expect(netFake.servers.size).toBe(1);
    const [entryB] = await liveRegistry();
    const ack = await sendCrossSessionFrame(entryB!.socketPath, entryB!.token, {
      sessionId: SESSION_B,
      messageId: 'm1',
      from: { sessionId: SESSION_C },
      message: 'still here',
    });
    expect(ack).toMatchObject({ kind: 'delivered' });
    expect(messaging.targets).toEqual([SESSION_B]);

    await host.releaseSession(SESSION_B);
    expect(host.boundSessions()).toEqual([]);
    expect(netFake.servers.size).toBe(0);
    expect(await liveRegistry()).toEqual([]);

    await host.bindSession(SESSION_A, sessionHandles.get(SESSION_A)!);
    await host.bindSession(SESSION_B, sessionHandles.get(SESSION_B)!);
    expect([...host.boundSessions()].toSorted()).toEqual([SESSION_A, SESSION_B].toSorted());
    expect(netFake.servers.size).toBe(1);
    const rebound = await liveRegistry();
    expect(rebound.map((entry) => entry.sessionId).toSorted()).toEqual(
      [SESSION_A, SESSION_B].toSorted(),
    );
    expect(rebound[0]?.token).not.toBe(originalToken);
    const entryA = rebound.find((entry) => entry.sessionId === SESSION_A)!;
    const reboundAck = await sendCrossSessionFrame(entryA.socketPath, entryA.token, {
      sessionId: SESSION_A,
      messageId: 'm2',
      from: { sessionId: SESSION_C },
      message: 'back again',
    });
    expect(reboundAck).toMatchObject({ kind: 'delivered' });
    expect(messaging.targets).toEqual([SESSION_B, SESSION_A]);
    host.dispose();
  });

  it('releaseSessionIsIdempotent', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    sessions.events.fireCreate(SESSION_A, sessionHandle({ sessionId: SESSION_A }));
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    await Promise.all([host.releaseSession(SESSION_A), host.releaseSession(SESSION_A)]);
    await host.releaseSession(SESSION_A);
    expect(host.boundSessions()).toEqual([]);
  });

  it('releaseSessionReportsRegistrationReleaseFailures', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      const sessions = hostSessions([sessionHandle({ sessionId: SESSION_A })]);
      const host = new CrossSessionInboxHost(
        sessions.manager,
        bootstrapStub(root),
        stubFlag(enabledFlag),
        fakeCrossSessionMessaging(),
      );
      await vi.waitFor(() => {
        expect(host.boundSessions()).toEqual([SESSION_A]);
      });
      const registryFile = join(resolveCrossSessionRegistryDir(root), `${SESSION_A}.json`);
      await rm(registryFile);
      await mkdir(registryFile, { recursive: true });
      await writeFile(join(registryFile, 'blocker'), 'x');

      await host.releaseSession(SESSION_A);

      expect(host.boundSessions()).toEqual([]);
      expect(unexpected).toHaveLength(1);
      expect((unexpected[0] as Error).message).toContain(SESSION_A);
      expect((unexpected[0] as Error).cause).toBeDefined();
      host.dispose();
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('releaseSessionWaitsForAPendingBind', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    sessions.events.fireCreate(SESSION_A, sessionHandle({ sessionId: SESSION_A }));
    await host.releaseSession(SESSION_A);
    expect(host.boundSessions()).toEqual([]);
    expect(await liveRegistry()).toEqual([]);
  });

  it('disabledHostIgnoresBindAndReleaseCalls', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(false),
      fakeCrossSessionMessaging(),
    );
    await host.bindSession(SESSION_A, sessionHandle({ sessionId: SESSION_A }));
    await host.releaseSession(SESSION_A);
    expect(host.boundSessions()).toEqual([]);
    expect(() =>
      (host as unknown as { requireRegistry(): unknown }).requireRegistry(),
    ).toThrow(/disabled/);
  });

  it('bindSessionFallsBackWhenTitlesAreUnavailable', async () => {
    const sessions = hostSessions();
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    const handle = {
      id: SESSION_A,
      kind: 'session',
      accessor: makeAccessor([]),
      dispose: () => {},
    } as unknown as ISessionScopeHandle;
    sessions.events.fireCreate(SESSION_A, handle);
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    expect((await liveRegistry())[0]?.title).toBeUndefined();
  });

  it('bindSessionClosesTheSocketWhenRegistryRegistrationFails', async () => {
    const badHome = join(root, 'bad-home');
    await writeFile(badHome, 'not a directory');
    const sessions = hostSessions();
    const handle = sessionHandle({ sessionId: SESSION_A });
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(badHome),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await expect(host.bindSession(SESSION_A, handle)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(host.boundSessions()).toEqual([]);
  });

  it('bindSessionPrunesTheGenerationAfterAPermanentFailure', async () => {
    const badHome = join(root, 'bad-home');
    await writeFile(badHome, 'not a directory');
    const sessions = hostSessions();
    const handle = sessionHandle({ sessionId: SESSION_A });
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(badHome),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );

    await expect(host.bindSession(SESSION_A, handle)).rejects.toMatchObject({ code: 'ENOTDIR' });

    const generations = (host as unknown as { bindGenerations: Map<string, number> })
      .bindGenerations;
    expect(generations.has(SESSION_A)).toBe(false);
  });

  it('createBindsInTheBackgroundAndRetriesAFailedBindOnce', async () => {
    const sessions = hostSessions();
    const handle = sessionHandle({ sessionId: SESSION_A, title: 'Alpha' });
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    netFake.failNextListen();
    expect(() => {
      sessions.events.fireCreate(SESSION_A, handle);
    }).not.toThrow();
    expect(sessions.events.waits).toEqual([]);
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    expect(netFake.serverCreateCount()).toBe(2);
    expect((await liveRegistry()).map((entry) => entry.sessionId)).toEqual([SESSION_A]);
  });

  it('releaseDuringAFailedBindCancelsTheRetry', async () => {
    const sessions = hostSessions();
    const handle = sessionHandle({ sessionId: SESSION_A });
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    netFake.failNextListen();
    vi.useFakeTimers();
    try {
      sessions.events.fireCreate(SESSION_A, handle);
      const releasing = host.releaseSession(SESSION_A);
      await vi.advanceTimersByTimeAsync(150);
      await releasing;
    } finally {
      vi.useRealTimers();
    }
    expect(host.boundSessions()).toEqual([]);
    expect(netFake.serverCreateCount()).toBe(1);
    expect(await liveRegistry()).toEqual([]);
  });

  it('tearsDownABindThatCompletesAfterRelease', async () => {
    const sessions = hostSessions();
    let releaseTitle: () => void = () => {};
    const titleReady = new Promise<void>((resolve) => {
      releaseTitle = resolve;
    });
    const metadata = {
      read: async () => {
        await titleReady;
        return { id: SESSION_A, createdAt: 0, updatedAt: 0, archived: false };
      },
    } as unknown as ISessionMetadata;
    const handle = {
      id: SESSION_A,
      kind: 'session',
      accessor: makeAccessor([[ISessionMetadata, metadata]]),
      dispose: () => {},
    } as unknown as ISessionScopeHandle;
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    sessions.events.fireCreate(SESSION_A, handle);
    const releasing = host.releaseSession(SESSION_A);
    releaseTitle();
    await releasing;
    expect(host.boundSessions()).toEqual([]);
    expect(await liveRegistry()).toEqual([]);
  });

  it('handlesAManagerWithoutLifecycleEvents', async () => {
    const handle = sessionHandle({ sessionId: SESSION_A });
    const base = fakeSessions([handle]) as unknown as Record<string, unknown>;
    const withoutEvents = { ...base };
    delete withoutEvents['onDidCreateSession'];
    delete withoutEvents['onWillCloseSession'];
    delete withoutEvents['onDidCloseSession'];
    delete withoutEvents['onDidArchiveSession'];
    const host = new CrossSessionInboxHost(
      withoutEvents as unknown as ISessionManager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
  });

  it('disposeReleasesBoundSessions', async () => {
    const sessions = hostSessions([sessionHandle({ sessionId: SESSION_A })]);
    const host = new CrossSessionInboxHost(
      sessions.manager,
      bootstrapStub(root),
      stubFlag(enabledFlag),
      fakeCrossSessionMessaging(),
    );
    await vi.waitFor(() => {
      expect(host.boundSessions()).toEqual([SESSION_A]);
    });
    host.dispose();
    await vi.waitFor(async () => {
      expect(await liveRegistry()).toEqual([]);
    });
  });
});

describe('crossSessionMessaging functional', () => {
  let host: ScopedTestHost;
  let root: string;
  let previousSocketDir: string | undefined;

  beforeEach(async () => {
    netFake.reset();
    host = createScopedTestHost();
    root = await mkdtemp(join(tmpdir(), 'cross-session-functional-'));
    previousSocketDir = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] = join(root, 'sockets');
  });

  afterEach(async () => {
    host.dispose();
    if (previousSocketDir === undefined) delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    else process.env[CROSS_SESSION_SOCKET_DIR_ENV] = previousSocketDir;
    netFake.reset();
    await rm(root, { recursive: true, force: true });
  });

  it('listsTwoLiveSessionsAndDeliversFromAToBThroughTheInProcessPath', async () => {
    const handles = new Map<string, ISessionScopeHandle>();
    const targetMessaging = fakeMessaging();
    const sourceMessaging = fakeMessaging();
    const didCreate = new Emitter<{
      sessionId: string;
      handle: ISessionScopeHandle;
      source: 'startup';
    }>();
    const controller = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: Event.None,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async (options: { sessionId?: string }) => {
        const sessionId = options.sessionId!;
        const handle = sessionHandle({
          sessionId,
          title: sessionId === SESSION_A ? 'Alpha' : 'Beta',
          loopState: sessionId === SESSION_A ? 'running' : 'idle',
          messaging: sessionId === SESSION_A ? sourceMessaging : targetMessaging,
        });
        handles.set(sessionId, handle);
        (didCreate as unknown as Emitter<{ sessionId: string; handle: ISessionScopeHandle; source: 'startup' }>).fire({
          sessionId,
          handle,
          source: 'startup',
        });
        return handle;
      },
      get: (id: string) => handles.get(id),
      list: () => [...handles.values()],
      resume: async () => undefined,
      close: async () => {},
      archive: async () => {},
      restore: async () => undefined,
      delete: async () => {},
      fork: async () => {
        throw new Error('not implemented');
      },
      createChild: async () => {
        throw new Error('not implemented');
      },
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => controller },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const sessions = new (await import('#/app/sessionManager/sessionManagerService')).SessionManager(
      workspaces,
      index,
    );
    const disposables = new DisposableStore();
    disposables.add({
      dispose: () => {
        sessions.dispose();
      },
    });

    await sessions.create({ sessionId: SESSION_A, workDir: '/workspace' });
    await sessions.create({ sessionId: SESSION_B, workDir: '/workspace' });

    const messaging = new CrossSessionMessagingService(
      sessions,
      stubFlag(enabledFlag),
      bootstrapStub(root),
    );

    const rows = await messaging.listSessions(SESSION_A);
    expect(rows).toEqual([{ sessionId: SESSION_B, title: 'Beta', status: 'idle' }]);

    const result = await messaging.send(SESSION_A, SESSION_B, {
      messageId: 'm1',
      message: 'hello from alpha',
      fromSessionTitle: 'Alpha',
    });

    expect(result).toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });
    expect(targetMessaging.received).toHaveLength(1);
    const inbox = await targetMessaging.listMessages(MAIN_AGENT_ID);
    expect(inbox.messages).toEqual([
      expect.objectContaining({
        id: 'm1',
        from: SESSION_A,
        fromSessionId: SESSION_A,
        fromSessionLabel: 'Alpha',
        message: 'hello from alpha',
      }),
    ]);
    disposables.dispose();
  });
});
