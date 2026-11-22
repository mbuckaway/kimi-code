import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '#/index';
import { logSeed, resolveLoggingConfig } from '#/_base/log/logConfig';
import type { Scope } from '#/_base/di/scope';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  createCrossSessionRegistry,
  type CrossSessionRegistration,
} from '#/features/messaging/crossSession/crossSessionRegistry';
import {
  CROSS_SESSION_MAX_FRAME_BYTES,
  CROSS_SESSION_SOCKET_DIR_ENV,
  CrossSessionFrameDecoder,
  encodeCrossSessionFrame,
  type CrossSessionAckFrame,
} from '#/features/messaging/crossSession/crossSessionTransport';
import { ICrossSessionMessagingService } from '#/features/messaging/crossSession/crossSessionMessaging';
import { ICrossSessionInboundService } from '#/features/messaging/crossSessionInboundService';
import { ISessionMessagingService } from '#/features/messaging/messaging';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { stubClientIdentity } from '../../app/bootstrap/stubs';

const SESSION_A = 'session_11111111-1111-4111-8111-111111111111';
const SESSION_B = 'session_22222222-2222-4222-8222-222222222222';

function readAck(socket: Socket): Promise<CrossSessionAckFrame> {
  return new Promise((resolve) => {
    const decoder = new CrossSessionFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === 'ack') resolve(frame);
      }
    });
  });
}

describe('cross-session messaging over Unix sockets', () => {
  let root: string;
  let homeDir: string;
  let socketDir: string;
  let registryDir: string;
  let previousSocketDir: string | undefined;
  let appA: Scope | undefined;
  let appB: Scope | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cross-session-e2e-'));
    homeDir = join(root, 'home');
    socketDir = join(root, 'sockets');
    registryDir = join(homeDir, 'messaging', 'registry');
    previousSocketDir = process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] = socketDir;
  });

  afterEach(async () => {
    appA?.dispose();
    appB?.dispose();
    appA = undefined;
    appB = undefined;
    if (previousSocketDir === undefined) delete process.env[CROSS_SESSION_SOCKET_DIR_ENV];
    else process.env[CROSS_SESSION_SOCKET_DIR_ENV] = previousSocketDir;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function bootEngine(): Scope {
    const { app } = bootstrap({ homeDir, clientIdentity: stubClientIdentity }, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
    ]);
    return app;
  }

  it('discovers, accepts, holds, refuses, drains, and replies across two engine scopes', async () => {
    appA = bootEngine();
    appB = bootEngine();
    const sessionsA = appA.accessor.get(ISessionManager);
    const sessionsB = appB.accessor.get(ISessionManager);

    const sessionA = await sessionsA.create({ sessionId: SESSION_A, workDir: root });
    const sessionB = await sessionsB.create({ sessionId: SESSION_B, workDir: root });
    await sessionA.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    await sessionB.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });

    expect(sessionsA.get(SESSION_B)).toBeUndefined();
    expect(sessionsB.get(SESSION_A)).toBeUndefined();

    const messagingA = appA.accessor.get(ICrossSessionMessagingService);
    const messagingB = appB.accessor.get(ICrossSessionMessagingService);
    const inboxB = sessionB.accessor.get(ISessionMessagingService);
    const inboxA = sessionA.accessor.get(ISessionMessagingService);
    const inboundB = sessionB.accessor.get(ICrossSessionInboundService);

    await vi.waitFor(
      async () => {
        const sockets = await readdir(socketDir);
        expect(sockets).toHaveLength(2);
        expect(sockets.every((name) => /^inbox-.+\.sock$/.test(name))).toBe(true);
        expect((await readdir(registryDir)).toSorted()).toEqual([
          `${SESSION_A}.json`,
          `${SESSION_B}.json`,
        ]);
      },
      { timeout: 5_000 },
    );

    const discovered = await messagingA.listSessions(SESSION_A);
    expect(discovered).toEqual([{ sessionId: SESSION_B, status: 'live' }]);

    const delivered = await messagingA.send(SESSION_A, SESSION_B, {
      messageId: 'message-1',
      message: 'hello from alpha',
      fromSessionTitle: 'Alpha',
    });
    expect(delivered).toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });
    const firstInbox = await inboxB.listMessages(MAIN_AGENT_ID);
    expect(firstInbox.messages).toEqual([
      expect.objectContaining({
        fromSessionId: SESSION_A,
        fromSessionLabel: 'Alpha',
        message: 'hello from alpha',
        delivery: 'newTurn',
      }),
    ]);

    inboundB.set('hold');
    const held = await messagingA.send(SESSION_A, SESSION_B, {
      messageId: 'message-2',
      message: 'held hello',
      fromSessionTitle: 'Alpha',
      inReplyTo: 'message-1',
    });
    expect(held).toEqual({ kind: 'held', truncated: false });
    expect(inboxB.listHeldCrossSessionMessages()).toEqual([
      expect.objectContaining({
        messageId: 'message-2',
        fromSessionId: SESSION_A,
        fromSessionTitle: 'Alpha',
        message: 'held hello',
        inReplyTo: 'message-1',
      }),
    ]);

    inboundB.set('refuse');
    const refused = await messagingA.send(SESSION_A, SESSION_B, {
      messageId: 'message-3',
      message: 'refused hello',
      fromSessionTitle: 'Alpha',
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'policy', truncated: false });
    expect(inboxB.listHeldCrossSessionMessages()).toHaveLength(1);

    inboundB.set('accept');
    await vi.waitFor(
      async () => {
        expect((await inboxB.listMessages(MAIN_AGENT_ID)).messages).toHaveLength(2);
      },
      { timeout: 5_000 },
    );
    const drained = await inboxB.listMessages(MAIN_AGENT_ID);
    expect(drained.messages.map((entry) => entry.message)).toEqual([
      'held hello',
      'hello from alpha',
    ]);
    expect(drained.messages.map((entry) => entry.fromSessionId)).toEqual([SESSION_A, SESSION_A]);
    expect(inboxB.listHeldCrossSessionMessages()).toEqual([]);

    const replied = await messagingB.send(SESSION_B, SESSION_A, {
      messageId: 'message-4',
      message: 'reply from beta',
      fromSessionTitle: 'Beta',
    });
    expect(replied).toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });
    const inboxOnA = await inboxA.listMessages(MAIN_AGENT_ID);
    expect(inboxOnA.messages).toEqual([
      expect.objectContaining({
        fromSessionId: SESSION_B,
        fromSessionLabel: 'Beta',
        message: 'reply from beta',
      }),
    ]);

    appB.dispose();
    appB = undefined;
    appA.dispose();
    appA = undefined;
    await vi.waitFor(
      async () => {
        await expect(readdir(socketDir)).resolves.toEqual([]);
        await expect(readdir(registryDir)).resolves.toEqual([]);
      },
      { timeout: 5_000 },
    );
  }, 120_000);

  it('delivers a message sent while the peer is still binding', async () => {
    appA = bootEngine();
    appB = bootEngine();
    const sessionsA = appA.accessor.get(ISessionManager);
    const sessionsB = appB.accessor.get(ISessionManager);

    const sessionA = await sessionsA.create({ sessionId: SESSION_A, workDir: root });
    await sessionA.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const sessionB = await sessionsB.create({ sessionId: SESSION_B, workDir: root });
    await sessionB.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });

    const registryFile = join(registryDir, `${SESSION_B}.json`);
    await vi.waitFor(
      async () => {
        expect(await readdir(registryDir)).toContain(`${SESSION_B}.json`);
      },
      { timeout: 5_000 },
    );
    const bound = JSON.parse(await readFile(registryFile, 'utf8')) as CrossSessionRegistration;
    await rm(registryFile);

    const messagingA = appA.accessor.get(ICrossSessionMessagingService);
    const inboxB = sessionB.accessor.get(ISessionMessagingService);
    const pending = messagingA.send(SESSION_A, SESSION_B, {
      messageId: 'message-bind-window',
      message: 'hello before the bind',
      fromSessionTitle: 'Alpha',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const registry = createCrossSessionRegistry({ registryDir });
    const handle = await registry.register({
      sessionId: SESSION_B,
      socketPath: bound.socketPath,
      token: bound.token,
    });

    await expect(pending).resolves.toEqual({
      kind: 'delivered',
      delivery: 'newTurn',
      truncated: false,
    });
    await vi.waitFor(
      async () => {
        expect((await inboxB.listMessages(MAIN_AGENT_ID)).messages).toEqual([
          expect.objectContaining({
            fromSessionId: SESSION_A,
            fromSessionLabel: 'Alpha',
            message: 'hello before the bind',
          }),
        ]);
      },
      { timeout: 5_000 },
    );
    await handle.release();
  }, 120_000);

  it('ignores malformed lines and drops oversized frames without killing the inbox', async () => {
    appA = bootEngine();
    appB = bootEngine();
    const sessionsA = appA.accessor.get(ISessionManager);
    const sessionsB = appB.accessor.get(ISessionManager);

    const sessionA = await sessionsA.create({ sessionId: SESSION_A, workDir: root });
    const sessionB = await sessionsB.create({ sessionId: SESSION_B, workDir: root });
    await sessionA.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    await sessionB.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });

    const registryFile = join(registryDir, `${SESSION_B}.json`);
    await vi.waitFor(
      async () => {
        expect(await readdir(registryDir)).toContain(`${SESSION_B}.json`);
      },
      { timeout: 5_000 },
    );
    const registration = JSON.parse(
      await readFile(registryFile, 'utf8'),
    ) as CrossSessionRegistration;

    const raw = createConnection(registration.socketPath);
    await once(raw, 'connect');
    const ackPromise = readAck(raw);
    raw.write('null\n[]\n42\n"text"\n');
    raw.write(encodeCrossSessionFrame({ type: 'auth', token: registration.token }));
    raw.write('null\n[]\n42\n"text"\n');
    raw.write(
      encodeCrossSessionFrame({
        type: 'message',
        sessionId: SESSION_B,
        messageId: 'raw-1',
        from: { sessionId: SESSION_A },
        message: 'raw hello',
      }),
    );
    const ack = await ackPromise;
    expect(ack).toMatchObject({ messageId: 'raw-1', kind: 'delivered' });
    raw.destroy();

    const oversized = createConnection(registration.socketPath);
    oversized.on('error', () => {});
    await once(oversized, 'connect');
    oversized.write('x'.repeat(CROSS_SESSION_MAX_FRAME_BYTES + 1));
    await once(oversized, 'close');

    const messagingA = appA.accessor.get(ICrossSessionMessagingService);
    await expect(
      messagingA.send(SESSION_A, SESSION_B, {
        messageId: 'after-oversized',
        message: 'still alive',
      }),
    ).resolves.toEqual({ kind: 'delivered', delivery: 'newTurn', truncated: false });
  }, 120_000);
});
