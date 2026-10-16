import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino, type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAppendLogStore,
  IBootstrapService,
  IFileSystemStorageService,
  IHostRequestHeaders,
  InMemoryStorageService,
  IOAuthToolkit,
  ITelemetryService,
  noopTelemetryService,
} from '@moonshot-ai/agent-core-v2';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { registerShutdownRoutes } from '../src/routes/shutdown';
import {
  CLOSE_DRAIN_TIMEOUT_MS,
  listenWithPortRetry,
  type RunningServer,
  startServer,
} from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

const closeDrainSeams = vi.hoisted(() => ({
  sessionMetadataWrites: vi.fn<() => Promise<void>>(),
  sessionIndexMirror: vi.fn<() => Promise<void>>(),
  globalSearchDisposals: vi.fn<() => Promise<void>>(),
  queryStoreDisposals: vi.fn<() => Promise<void>>(),
  logCloses: vi.fn<() => Promise<void>>(),
}));

vi.mock('@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadataService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadataService')
  >();
  closeDrainSeams.sessionMetadataWrites.mockImplementation(actual.drainSessionMetadataWrites);
  return { ...actual, drainSessionMetadataWrites: closeDrainSeams.sessionMetadataWrites };
});

vi.mock('@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndexMirrorService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndexMirrorService')
  >();
  closeDrainSeams.sessionIndexMirror.mockImplementation(actual.drainSessionIndexMirror);
  return { ...actual, drainSessionIndexMirror: closeDrainSeams.sessionIndexMirror };
});

vi.mock('@moonshot-ai/agent-core-v2/persistence/backends/minidb/miniDbQueryStore', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@moonshot-ai/agent-core-v2/persistence/backends/minidb/miniDbQueryStore')
  >();
  closeDrainSeams.queryStoreDisposals.mockImplementation(actual.drainQueryStoreDisposals);
  return { ...actual, drainQueryStoreDisposals: closeDrainSeams.queryStoreDisposals };
});

vi.mock('@moonshot-ai/agent-core-v2/_base/log/logService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@moonshot-ai/agent-core-v2/_base/log/logService')
  >();
  closeDrainSeams.logCloses.mockImplementation(actual.drainLogCloses);
  return { ...actual, drainLogCloses: closeDrainSeams.logCloses };
});

vi.mock('../src/search/searchService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/search/searchService')>();
  closeDrainSeams.globalSearchDisposals.mockImplementation(actual.drainGlobalSearchDisposals);
  return { ...actual, drainGlobalSearchDisposals: closeDrainSeams.globalSearchDisposals };
});

function shutdownReplyHarness(onShutdown: () => void): {
  raw: EventEmitter;
  sendReply: () => void;
} {
  const raw = new EventEmitter();
  let routeHandler:
    | ((req: { id: string }, reply: { send(payload: unknown): unknown }) => void)
    | undefined;
  const host = {
    post(
      _path: string,
      _options: unknown,
      handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => void,
    ): unknown {
      routeHandler = handler;
      return undefined;
    },
  };
  registerShutdownRoutes(host as unknown as Parameters<typeof registerShutdownRoutes>[0], {
    onShutdown,
  });
  const registered = routeHandler;
  if (registered === undefined) throw new Error('shutdown route was not registered');
  return {
    raw,
    sendReply: () => {
      registered({ id: 'req-1' }, { send: () => undefined, raw } as never);
    },
  };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, sink), lines };
}

interface CloseWarningRecord {
  readonly level?: number;
  readonly drains?: string[];
  readonly drain?: string;
  readonly err?: string;
}

function warnRecords(lines: string[]): CloseWarningRecord[] {
  return lines
    .map((line) => JSON.parse(line) as CloseWarningRecord)
    .filter((record) => record.level === 40);
}

function abandonedDrains(lines: string[]): string[] {
  return warnRecords(lines).find((record) => record.drains !== undefined)?.drains ?? [];
}

function stallingDrain(): {
  promise: Promise<void>;
  release: () => void;
  rejectWith: (error: Error) => void;
} {
  let release = (): void => {};
  let reject = (_error: Error): void => {};
  const promise = new Promise<void>((resolve, deny) => {
    release = resolve;
    reject = deny;
  });
  return {
    promise,
    release,
    rejectWith: (error) => {
      reject(error);
    },
  };
}

async function advanceUntilOrBudget(
  isDone: () => boolean,
  stepMs: number,
  budgetMs: number,
): Promise<void> {
  for (let advanced = 0; advanced < budgetMs && !isDone(); advanced += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

describe('server-v2 boot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('boots agent-core-v2 and serves the basic /api/v1 routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      enableKimiOauth: true,
    });

    const base = `http://127.0.0.1:${server.port}`;

    const healthz = await fetch(`${base}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
    const healthBody = await healthz.json() as {
      code: number;
      data: { ok: boolean };
      request_id: string;
    };
    expect(healthBody.code).toBe(0);
    expect(healthBody.data.ok).toBe(true);
    expect(typeof healthBody.request_id).toBe('string');

    const meta = await authedFetch(server, base, '/api/v1/meta');
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      code: number;
      data: { server_id: string; server_version: string; capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(typeof metaBody.data.server_id).toBe('string');
    expect(typeof metaBody.data.server_version).toBe('string');
    expect(metaBody.data.capabilities).toBeDefined();

    const auth = await authedFetch(server, base, '/api/v1/auth');
    expect(auth.status).toBe(200);
    const authBody = await auth.json() as {
      code: number;
      data: { models_ready: boolean; providers_count: number };
    };
    expect(authBody.code).toBe(0);
    expect(typeof authBody.data.models_ready).toBe('boolean');
    expect(authBody.data.providers_count).toBeGreaterThanOrEqual(0);

    const oauthPoll = await authedFetch(server, base, '/api/v1/oauth/login');
    expect(oauthPoll.status).toBe(200);
    const oauthBody = await oauthPoll.json() as { code: number; data: null };
    expect(oauthBody.code).toBe(0);
    expect(oauthBody.data).toBeNull();
  });

  it('reports opts.serverVersion as server_version instead of the package version', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-version-'));
    server = await startServer({
      hostIdentity: {
        productName: 'test-host',
        version: '9.9.9-host',
        platform: 'test_platform',
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      serverVersion: '9.9.9-host',
    });

    const base = `http://127.0.0.1:${server.port}`;
    const meta = await authedFetch(server, base, '/api/v1/meta');
    const metaBody = await meta.json() as {
      code: number;
      data: { server_version: string };
    };
    expect(metaBody.data.server_version).toBe('9.9.9-host');

    const [instance] = await listLiveServerInstances(home);
    expect(instance?.serverVersion).toBe('9.9.9-host');

    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/9.9.9-host');
    expect(server.core.accessor.get(IBootstrapService).clientIdentity).toEqual({
      productName: 'test-host',
      version: '9.9.9-host',
      platform: 'test_platform',
    });
  });

  it('seeds default Kimi identity headers from hostIdentity that opts.seeds can override', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ua-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/0.0.0-test');
    expect(defaults.headers['X-Msh-Version']).toBe('0.0.0-test');
    expect(defaults.headers['X-Msh-Platform']).toBe('test_platform');

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IHostRequestHeaders, { headers: { 'User-Agent': 'custom-host/9.9' } }]],
    });
    const overridden = server.core.accessor.get(IHostRequestHeaders);
    expect(overridden.headers['User-Agent']).toBe('custom-host/9.9');
  });

  it('seeds explicit skill dirs into the core scope when skillDirs is provided', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      skillDirs: ['/skills/explicit'],
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toEqual([
      '/skills/explicit',
    ]);

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toBeUndefined();
  });

  it('does not shut down a host-injected telemetry service when server telemetry is disabled', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-host-telemetry-'));
    await writeFile(join(home, 'config.toml'), 'telemetry = false\n', 'utf8');
    const shutdown = vi.fn(async () => {});

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ITelemetryService, { ...noopTelemetryService, shutdown }]],
    });

    await server.close();
    server = undefined;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('completes server cleanup when owned telemetry shutdown fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-telemetry-failure-'));
    const storage = new InMemoryStorageService();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (scope === 'telemetry') throw new Error('telemetry storage unavailable');
      await write(scope, key, data, options);
    });
    const auth = {
      _serviceBrand: undefined,
      getCachedAccessToken: async () => {
        throw new Error('telemetry auth unavailable');
      },
    } as unknown as IOAuthToolkit;

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      telemetry: true,
      seeds: [
        [IFileSystemStorageService, storage],
        [IOAuthToolkit, auth],
      ],
    });
    const core = server.core;
    core.accessor.get(ITelemetryService).track('server_probe');

    await server.close();
    server = undefined;

    expect(() => core.accessor.get(IBootstrapService)).toThrow();
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it('runs one close even when callers ask to close concurrently and again', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-double-close-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const core = server.core;

    const concurrent = await Promise.all([server.close(), server.close()]);
    expect(concurrent).toEqual([undefined, undefined]);
    await expect(server.close()).resolves.toBeUndefined();

    expect(() => core.accessor.get(IBootstrapService)).toThrow();
    expect(await listLiveServerInstances(home)).toEqual([]);
    server = undefined;
  });

  it('delivers the shutdown reply over the loopback socket before closing the server', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-shutdown-route-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await authedFetch(server, base, '/api/v1/shutdown', { method: 'POST' });
    const body = (await res.json()) as { code: number; msg: string; data: { ok: boolean } };

    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ ok: true });

    await server.close();
    server = undefined;
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it('withholds the shutdown until the reply has flushed to the socket', async () => {
    const onShutdown = vi.fn();
    const { raw, sendReply } = shutdownReplyHarness(onShutdown);

    sendReply();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(onShutdown).not.toHaveBeenCalled();

    raw.emit('finish');
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('still shuts down when the client aborts before the reply finishes', () => {
    const onShutdown = vi.fn();
    const { raw, sendReply } = shutdownReplyHarness(onShutdown);

    sendReply();
    raw.emit('close');
    raw.emit('finish');

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  describe('close drain budget', () => {
    const advanceStepMs = 25;
    const advanceCeilingMs = CLOSE_DRAIN_TIMEOUT_MS * 8;
    const sharedDeadlineCeilingMs = CLOSE_DRAIN_TIMEOUT_MS * 5;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('abandons a hung drain once the shared close budget expires', async () => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-drain-budget-'));
      const { logger, lines } = recordingLogger();
      const rejectionHandlersBefore = process.listenerCount('unhandledRejection');
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logger,
      });
      const closingServer = server;
      const core = closingServer.core;
      const drainRetirements = vi.spyOn(core.accessor.get(IAppendLogStore), 'drainRetirements');
      let drainGroupStartedAtMs = -1;
      const stalled = stallingDrain();
      closeDrainSeams.sessionMetadataWrites.mockImplementationOnce(async () => {
        drainGroupStartedAtMs = Date.now();
      });
      closeDrainSeams.logCloses.mockImplementationOnce(() => stalled.promise);

      vi.useFakeTimers();
      let elapsedMsAtClose = -1;
      try {
        const closing = closingServer.close().then(() => {
          elapsedMsAtClose = Date.now() - drainGroupStartedAtMs;
        });
        await advanceUntilOrBudget(() => elapsedMsAtClose >= 0, advanceStepMs, advanceCeilingMs);
        await closing;
        expect(elapsedMsAtClose).toBeGreaterThanOrEqual(CLOSE_DRAIN_TIMEOUT_MS);
        expect(elapsedMsAtClose).toBeLessThan(sharedDeadlineCeilingMs);
        expect(abandonedDrains(lines)).toEqual(['drainLogCloses']);
        expect(drainRetirements).toHaveBeenCalledTimes(2);
        expect(() => core.accessor.get(IBootstrapService)).toThrow();
        expect(process.listenerCount('unhandledRejection')).toBe(rejectionHandlersBefore + 1);

        stalled.rejectWith(new Error('search worker refused to close'));
        await vi.advanceTimersByTimeAsync(0);
        expect(process.listenerCount('unhandledRejection')).toBe(rejectionHandlersBefore);
        expect(
          warnRecords(lines).find((record) => record.drain === 'drainLogCloses')?.err,
        ).toContain('search worker refused to close');
      } finally {
        stalled.release();
        server = undefined;
      }
    });

    it('bounds the whole raced drain group at one shared deadline', async () => {
      home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-drain-group-budget-'));
      const { logger, lines } = recordingLogger();
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logger,
      });
      const closingServer = server;
      const core = closingServer.core;
      const drainRetirements = vi.spyOn(core.accessor.get(IAppendLogStore), 'drainRetirements');
      let drainGroupStartedAtMs = -1;
      const groupStall = stallingDrain();
      const otherStalls = [stallingDrain(), stallingDrain(), stallingDrain(), stallingDrain()];
      closeDrainSeams.sessionMetadataWrites
        .mockImplementationOnce(() => {
          drainGroupStartedAtMs = Date.now();
          return groupStall.promise;
        })
        .mockImplementationOnce(() => otherStalls[0]!.promise);
      closeDrainSeams.sessionIndexMirror.mockImplementationOnce(() => otherStalls[1]!.promise);
      closeDrainSeams.globalSearchDisposals.mockImplementationOnce(() => otherStalls[2]!.promise);
      closeDrainSeams.queryStoreDisposals.mockImplementationOnce(() => otherStalls[3]!.promise);

      vi.useFakeTimers();
      let elapsedMsAtClose = -1;
      try {
        const closing = closingServer.close().then(() => {
          elapsedMsAtClose = Date.now() - drainGroupStartedAtMs;
        });
        await advanceUntilOrBudget(() => elapsedMsAtClose >= 0, advanceStepMs, advanceCeilingMs);
        await closing;

        expect(elapsedMsAtClose).toBeGreaterThanOrEqual(CLOSE_DRAIN_TIMEOUT_MS);
        expect(elapsedMsAtClose).toBeLessThan(sharedDeadlineCeilingMs);
        expect(abandonedDrains(lines)).toEqual([
          'drainSessionMetadataWrites',
          'ISessionIndexMirror.drain',
          'IMcpOAuthService.shutdown',
          'drainSessionIndexMirror',
          'drainGlobalSearchDisposals',
          'drainQueryStoreDisposals',
          'drainSessionMetadataWrites',
          'drainLogCloses',
        ]);
        expect(drainRetirements).toHaveBeenCalledTimes(2);
        expect(() => core.accessor.get(IBootstrapService)).toThrow();
      } finally {
        groupStall.release();
        for (const stall of otherStalls) {
          stall.release();
        }
        server = undefined;
      }
    });
  });

  it('installs process-level rejection handlers while running and removes them on close', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    const rejectionBefore = process.listenerCount('unhandledRejection');
    const exceptionBefore = process.listenerCount('uncaughtException');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore + 1);
    expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore + 1);

    await server.close();
    server = undefined;

    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore);
    expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore);
  });

  it('does not leave process handlers installed when startup fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    const emptyAssets = await mkdtemp(join(tmpdir(), 'kimi-server-v2-assets-'));
    const rejectionBefore = process.listenerCount('unhandledRejection');
    const exceptionBefore = process.listenerCount('uncaughtException');
    try {
      await expect(
        startServer({
          hostIdentity: TEST_HOST_IDENTITY,
          host: '127.0.0.1',
          port: 0,
          homeDir: home,
          logLevel: 'silent',
          webAssetsDir: emptyAssets,
        }),
      ).rejects.toThrow('web assets');
      expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore);
      expect(process.listenerCount('uncaughtException')).toBe(exceptionBefore);
    } finally {
      await rm(emptyAssets, { recursive: true, force: true });
    }
  });
});

function silentLogger() {
  return pino({ level: 'silent' });
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  err.code = 'EADDRINUSE';
  return err;
}

function listenOnPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function allocateAdjacentFreePair(
  host = '127.0.0.1',
): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 30; i++) {
    const a = await listenOnPort(host, 0);
    const address = a.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await closeNetServer(a);
    if (port <= 0 || port >= 65535) continue;
    const probe = await listenOnPort(host, port + 1).catch(() => null);
    if (probe === null) continue;
    await closeNetServer(probe);
    return { port, next: port + 1 };
  }
  throw new Error('could not allocate an adjacent free port pair');
}

describe('listenWithPortRetry', () => {
  it('returns the requested port when the first listen succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5000);
    expect(attempts).toEqual([5000]);
  });

  it('retries with port+1 on EADDRINUSE until a bind succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        if (port < 5002) throw addrInUse();
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5002);
    expect(result.address).toBe('http://127.0.0.1:5002');
    expect(attempts).toEqual([5000, 5001, 5002]);
  });

  it('does not retry on non-EADDRINUSE errors', async () => {
    const attempts: number[] = [];
    const boom = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw boom;
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
      }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([5000]);
  });

  it('throws after exhausting maxRetries', async () => {
    const attempts: number[] = [];
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw addrInUse();
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(attempts).toEqual([5000, 5001, 5002, 5003]);
  });

  it('does not walk ports when the requested port is 0 (ephemeral)', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return 'http://127.0.0.1:54321';
      },
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
    });

    expect(result.port).toBe(0);
    expect(attempts).toEqual([0]);
  });
});

describe('server-v2 boot — port retry', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('retries on port+1 and advertises the bound port in the instance registry', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-port-retry-'));
    const { port, next } = await allocateAdjacentFreePair();
    const occupant = await listenOnPort('127.0.0.1', port);
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port,
        homeDir: home,
        logLevel: 'silent',
      });

      expect(server.port).toBeGreaterThanOrEqual(next);
      const [instance] = await listLiveServerInstances(home);
      expect(instance?.port).toBe(server.port);
    } finally {
      await closeNetServer(occupant);
    }
  });
});
