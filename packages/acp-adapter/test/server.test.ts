import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { runAcpServerOnSocket } from '../src/socket';
import { TERMINAL_AUTH_METHOD } from '../src';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

/** Minimal Client that throws on every callback so tests fail loudly. */
class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in Phase 2');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in Phase 2');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in Phase 2');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in Phase 2');
  }
}

/**
 * Build a bidirectional in-memory ndJSON pair:
 *  - agentSide reads `clientToAgent` and writes to `agentToClient`
 *  - clientSide reads `agentToClient` and writes to `clientToAgent`
 */
function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

describe('AcpServer + AgentSideConnection', () => {
  it('responds to initialize with negotiated v1 capabilities', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    // Agent side
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    // Client side
    const client = new ClientSideConnection((_agent) => new StubClient(), clientStream);

    const request: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    };

    const response = await client.initialize(request);

    expect(response.protocolVersion).toBe(1);
    expect(response.authMethods).toEqual([TERMINAL_AUTH_METHOD]);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.audio).toBe(false);
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
  });

  it('initialize advertises terminal-auth with id, type, args, name', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    expect(response.authMethods).toHaveLength(1);
    const method = response.authMethods?.[0];
    expect(method).toMatchObject({
      id: 'login',
      type: 'terminal',
      name: expect.any(String),
      args: ['--login'],
    });
  });

  it('honors version negotiation: client v99 still negotiates to v1', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 99 });
    expect(response.protocolVersion).toBe(1);
  });

  it('initialize returns the supplied agentInfo', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentInfo = { name: 'Kimi Code CLI', version: '9.9.9-test' };
    new AgentSideConnection(
      (c) => new AcpServer(harness, c, { agentInfo }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.agentInfo).toEqual(agentInfo);
  });

  it('initialize omits agentInfo when not supplied', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.agentInfo).toBeUndefined();
  });

  it('initialize forwards terminalAuthEnv into authMethods[0].env', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const terminalAuthEnv = { KIMI_CODE_HOME: '/tmp/kimi-debug' };
    new AgentSideConnection(
      (c) => new AcpServer(harness, c, { terminalAuthEnv }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.authMethods).toHaveLength(1);
    const method = response.authMethods?.[0] as { env?: Record<string, string> };
    expect(method.env).toEqual({ KIMI_CODE_HOME: '/tmp/kimi-debug' });
  });

  it('initialize emits legacy _meta["terminal-auth"] when terminalAuthLegacyCommand is set', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (c) =>
        new AcpServer(harness, c, {
          terminalAuthLegacyCommand: '/abs/path/to/kimi',
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    const method = response.authMethods?.[0] as {
      args?: string[];
      env?: Record<string, string>;
      _meta?: { 'terminal-auth'?: Record<string, unknown> };
    };
    // First-class path still uses '--login' for the appended-args form.
    expect(method.args).toEqual(['--login']);
    // Legacy _meta fallback uses absolute command + 'login' subcommand.
    expect(method._meta?.['terminal-auth']).toEqual({
      type: 'terminal',
      label: 'Login with Kimi account',
      command: '/abs/path/to/kimi',
      args: ['login'],
      env: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
    });
  });

  it('initialize omits _meta["terminal-auth"] when terminalAuthLegacyCommand is unset', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    const method = response.authMethods?.[0] as {
      _meta?: { 'terminal-auth'?: unknown } | null;
    };
    expect(method._meta?.['terminal-auth']).toBeUndefined();
  });
});

/**
 * Unique socket path per test run: filesystem path on POSIX, named-pipe
 * path on Windows (same `node:net` API serves both). The id is
 * truncated because macOS caps unix-socket paths at 104 bytes and the
 * temp-dir prefix already eats half of it.
 */
function makeSocketPath(): string {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\acp-server-test-${id}`
    : join(tmpdir(), `acp-srv-${id}.sock`);
}

/** Poll-connect: the server has no readiness callback, so a refused
 * connect just means `listen()` hasn't completed yet. */
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

describe('runAcpServerOnSocket', () => {
  it('serves two concurrent clients over one socket with independent sessions', async () => {
    // Same minimal authed-harness shape session-new.test.ts uses: the
    // socket runner only forwards to `runAcpServerWithStream`, so
    // session/new exercises the exact server path already covered
    // in-memory — what's new here is the transport multiplexing.
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async (options: { id?: string; workDir: string }) =>
        ({
          id: options.id ?? 'fallback',
          prompt: async () => undefined,
          cancel: async () => undefined,
          onEvent: () => () => undefined,
        }) as unknown as Session,
      getConfig: async () => ({ providers: {}, models: {} }),
      close: async () => undefined,
    } as unknown as KimiHarness;

    const signals = new EventEmitter();
    const socketPath = makeSocketPath();
    const run = runAcpServerOnSocket(harness, { socketPath, signals });

    const openClient = async (): Promise<{ socket: Socket; client: ClientSideConnection }> => {
      const socket = await connectWhenReady(socketPath);
      const { readable, writable } = Duplex.toWeb(socket);
      const client = new ClientSideConnection(
        (_agent) => new StubClient(),
        ndJsonStream(writable, readable),
      );
      return { socket, client };
    };

    const a = await openClient();
    const b = await openClient();

    const [initA, initB] = await Promise.all([
      a.client.initialize({ protocolVersion: 1 }),
      b.client.initialize({ protocolVersion: 1 }),
    ]);
    expect(initA.protocolVersion).toBe(1);
    expect(initB.protocolVersion).toBe(1);

    const [sessionA, sessionB] = await Promise.all([
      a.client.newSession({ cwd: '/tmp/a', mcpServers: [] }),
      b.client.newSession({ cwd: '/tmp/b', mcpServers: [] }),
    ]);
    expect(typeof sessionA.sessionId).toBe('string');
    expect(typeof sessionB.sessionId).toBe('string');
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    // Orderly client disconnects before the signal so the drain isn't
    // racing in-flight requests.
    a.socket.end();
    b.socket.end();
    await new Promise((resolve) => setTimeout(resolve, 20));

    signals.emit('SIGINT');
    await run;
  });
});
