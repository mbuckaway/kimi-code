import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../src/log';
import { runAcpServerOnSocket } from '../src/socket';

/**
 * Every `net.Server` the socket transport creates, newest last. The transport
 * keeps the server private, so a test that needs to emit a post-listen
 * `'error'` on it (the event Node re-throws when nothing is listening) reaches
 * it through this recorder.
 */
const { createdServers } = vi.hoisted(() => ({ createdServers: [] as Server[] }));

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>): Server => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

/** Minimal Client that throws on every callback so a stray reverse-RPC fails the test loudly. */
class StubClient implements Client {
  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called by these tests');
  }
  async sessionUpdate(_params: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called by these tests');
  }
  async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called by these tests');
  }
  async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called by these tests');
  }
}

/**
 * Unique socket path per test: a filesystem path under the OS temp dir on
 * POSIX, a named-pipe path on Windows (the same `node:net` API serves
 * both). The id is truncated because macOS caps unix-socket paths at 104
 * bytes and the temp-dir prefix already uses up half of that.
 */
function makeSocketPath(): string {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\acp-server-test-${id}`
    : join(tmpdir(), `acp-srv-${id}.sock`);
}

/**
 * Connect once the server is actually accepting. `runAcpServerOnSocket` has
 * no readiness callback, so tests poll: a refused connect just means
 * `listen()` has not completed yet.
 */
async function connectWhenReady(socketPath: string): Promise<Socket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = createConnection(socketPath);
    try {
      await once(socket, 'connect');
      return socket;
    } catch (error) {
      lastError = error;
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Open a client connection and wrap it in a `ClientSideConnection`. */
async function openClient(
  socketPath: string,
): Promise<{ socket: Socket; client: ClientSideConnection }> {
  const socket = await connectWhenReady(socketPath);
  const { readable, writable } = Duplex.toWeb(socket);
  const client = new ClientSideConnection((_agent) => new StubClient(), ndJsonStream(writable, readable));
  return { socket, client };
}

/** The `net.Server` the transport under test created most recently. */
function lastCreatedServer(): Server {
  const server = createdServers.at(-1);
  if (server === undefined) {
    throw new Error('runAcpServerOnSocket did not create a net.Server');
  }
  return server;
}

/**
 * Resolves `'closed'` when the server drops the connection, `'open'` when it
 * is still alive after the grace period — a bounded wait so a server that
 * wrongly keeps the socket fails fast instead of hitting the test timeout.
 */
async function settleWithin(socket: Socket, ms: number): Promise<'closed' | 'open'> {
  socket.on('error', () => undefined);
  return Promise.race([
    once(socket, 'close').then(() => 'closed' as const),
    new Promise<'open'>((resolve) => {
      setTimeout(() => {
        resolve('open');
      }, ms);
    }),
  ]);
}

describe('runAcpServerOnSocket', () => {
  let homeDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function makeHomeDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    homeDir = dir;
    return dir;
  }

  it(
    'serves two concurrent clients over one socket with independent sessions',
    async () => {
      const dir = await makeHomeDir('acp-socket-concurrent-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      const a = await openClient(socketPath);
      const b = await openClient(socketPath);

      const [initA, initB] = await Promise.all([
        a.client.initialize({ protocolVersion: 1, clientCapabilities: {} }),
        b.client.initialize({ protocolVersion: 1, clientCapabilities: {} }),
      ]);
      expect(initA.protocolVersion).toBe(1);
      expect(initB.protocolVersion).toBe(1);

      const [sessionA, sessionB] = await Promise.all([
        a.client.newSession({ cwd: dir, mcpServers: [] }),
        b.client.newSession({ cwd: dir, mcpServers: [] }),
      ]);
      expect(typeof sessionA.sessionId).toBe('string');
      expect(typeof sessionB.sessionId).toBe('string');
      expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

      // Orderly client disconnects before the signal so the drain below
      // isn't racing in-flight requests.
      a.socket.end();
      b.socket.end();
      await new Promise((resolve) => setTimeout(resolve, 20));

      signals.emit('SIGINT');
      await run;
    },
    30_000,
  );

  it(
    'stops accepting and destroys live connections on SIGINT',
    async () => {
      const dir = await makeHomeDir('acp-socket-sigint-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      // Readiness probe: proves the server accepted at least one client
      // before the signal lands. Left open on purpose — the shutdown path
      // must destroy it, not rely on the client disconnecting first.
      const probe = await connectWhenReady(socketPath);

      signals.emit('SIGINT');
      await run;

      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);

      // The listener is gone: a fresh connect must be refused.
      const late = createConnection(socketPath);
      await expect(once(late, 'connect')).rejects.toThrow(/ENOENT|ECONNREFUSED/);
      late.destroy();
      probe.destroy();
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'removes the socket file from disk on SIGINT',
    async () => {
      const dir = await makeHomeDir('acp-socket-unlink-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      expect(existsSync(socketPath)).toBe(true);
      probe.destroy();

      signals.emit('SIGINT');
      await run;

      expect(existsSync(socketPath)).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'rebinds and listens when a stale socket file already occupies the path',
    async () => {
      const dir = await makeHomeDir('acp-socket-stale-');
      const socketPath = makeSocketPath();
      // Simulate a crashed previous run: a plain leftover file where the
      // socket should be. listen() would fail with EADDRINUSE if the
      // server didn't remove it first.
      await writeFile(socketPath, 'stale');

      const signals = new EventEmitter();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      expect((await stat(socketPath)).isSocket()).toBe(true);
      probe.destroy();

      signals.emit('SIGINT');
      await run;

      expect(existsSync(socketPath)).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'creates the socket file with owner-only 0600 permissions',
    async () => {
      const dir = await makeHomeDir('acp-socket-mode-');
      const socketPath = makeSocketPath();
      const signals = new EventEmitter();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      const mode = (await stat(socketPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      probe.destroy();

      signals.emit('SIGINT');
      await run;
    },
    30_000,
  );

  it(
    'keeps a second client functional after the first disconnects abruptly',
    async () => {
      const dir = await makeHomeDir('acp-socket-isolation-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      // First client connects then drops mid-handshake — its per-connection
      // core, if it ever boots, must fail in isolation.
      const badSocket = await connectWhenReady(socketPath);
      badSocket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const good = await openClient(socketPath);
      const init = await good.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(init.protocolVersion).toBe(1);
      const session = await good.client.newSession({ cwd: dir, mcpServers: [] });
      expect(typeof session.sessionId).toBe('string');

      good.socket.end();
      await new Promise((resolve) => setTimeout(resolve, 20));

      signals.emit('SIGINT');
      await run;
    },
    30_000,
  );

  it(
    'logs a post-listen server error instead of letting it take the process down',
    async () => {
      const dir = await makeHomeDir('acp-socket-server-error-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });

      const client = await openClient(socketPath);
      const server = lastCreatedServer();

      // Without a permanent listener Node re-throws the event, so a single
      // post-listen failure would kill the shared server and every client
      // still connected to it.
      expect(() => server.emit('error', new Error('post-listen accept failure'))).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith('acp: socket server error', {
        socketPath,
        error: 'post-listen accept failure',
      });

      // The connection opened before the error is still served.
      const init = await client.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(init.protocolVersion).toBe(1);

      client.socket.end();
      await new Promise((resolve) => setTimeout(resolve, 20));
      signals.emit('SIGINT');
      await run;
    },
    30_000,
  );

  it(
    'refuses connections past maxConnections and keeps the accepted client serving',
    async () => {
      const dir = await makeHomeDir('acp-socket-cap-');
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      const run = runAcpServerOnSocket({
        homeDir: dir,
        disableAuth: true,
        socketPath,
        signals,
        maxConnections: 1,
      });

      const accepted = await openClient(socketPath);
      const refused = createConnection(socketPath);
      const outcome = await settleWithin(refused, 500);

      expect(outcome).toBe('closed');
      expect(warnSpy).toHaveBeenCalledWith('acp: socket connection limit reached, refusing client', {
        socketPath,
        maxConnections: 1,
      });

      // The client under the cap is unaffected by the refusal.
      const init = await accepted.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(init.protocolVersion).toBe(1);

      refused.destroy();
      accepted.socket.end();
      await new Promise((resolve) => setTimeout(resolve, 20));
      signals.emit('SIGINT');
      await run;
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'rejects when clearing a stale socket path fails with anything but ENOENT',
    async () => {
      const dir = await makeHomeDir('acp-socket-unlink-fail-');
      const socketPath = makeSocketPath();
      // A directory at the socket path makes the startup unlink fail with
      // EPERM/EISDIR — the class of error that must NOT be swallowed the way
      // "nothing stale here" (ENOENT) is.
      await mkdir(socketPath);
      const signals = new EventEmitter();

      try {
        await expect(
          runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals }),
        ).rejects.toThrow(/EPERM|EISDIR/);

        // The failure happened before any wiring: no signal handlers left
        // behind, nothing listening on the path.
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
      } finally {
        await rm(socketPath, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'warns that a Windows named pipe carries no filesystem access boundary',
    async () => {
      const dir = await makeHomeDir('acp-socket-win32-');
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();
      const realPlatform = process.platform;

      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      let run: Promise<void>;
      try {
        // The platform check (and the warning) happen before the first await,
        // so the real platform can go back immediately — everything after
        // this point runs on the host's own filesystem semantics.
        run = runAcpServerOnSocket({ homeDir: dir, disableAuth: true, socketPath, signals });
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }

      expect(warnSpy).toHaveBeenCalledWith('acp: named pipe has no filesystem access boundary', {
        socketPath,
      });

      try {
        const probe = await connectWhenReady(socketPath);
        probe.destroy();
        signals.emit('SIGINT');
        await run;
      } finally {
        // The win32 branch skips the POSIX unlink, so clean up by hand.
        await rm(socketPath, { force: true });
      }
    },
    30_000,
  );
});
