import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
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
import { afterEach, describe, expect, it } from 'vitest';

import { runAcpServerOnSocket } from '../src/socket';

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

describe('runAcpServerOnSocket', () => {
  let homeDir: string | undefined;

  afterEach(async () => {
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
    'stops accepting, destroys live connections, and unlinks the socket file on SIGINT',
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

      if (process.platform !== 'win32') {
        expect(existsSync(socketPath)).toBe(false);
      }
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
});
