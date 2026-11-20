import { timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  AgentInboxDelivery,
  CrossSessionReceiveResult,
  CrossSessionRefusalReason,
} from '#/features/messaging/messaging';

import { safeSessionFileName } from './crossSessionRegistry';

export const CROSS_SESSION_SOCKET_DIR_ENV = 'KIMI_CODE_CROSS_SESSION_SOCKET_DIR';

export interface CrossSessionPeer {
  readonly sessionId: string;
  readonly title?: string;
}

export interface CrossSessionInboundFrame {
  readonly type: 'message';
  readonly messageId: string;
  readonly from: CrossSessionPeer;
  readonly message: string;
  readonly inReplyTo?: string;
}

export interface CrossSessionAuthFrame {
  readonly type: 'auth';
  readonly token: string;
}

export type CrossSessionClientFrame = CrossSessionAuthFrame | CrossSessionInboundFrame;

export type CrossSessionAckKind = CrossSessionReceiveResult['kind'] | 'error';

export interface CrossSessionAckFrame {
  readonly type: 'ack';
  readonly messageId: string;
  readonly kind: CrossSessionAckKind;
  readonly delivery?: AgentInboxDelivery;
  readonly truncated: boolean;
  readonly reason?: CrossSessionRefusalReason;
  readonly error?: string;
}

export type CrossSessionWireFrame = CrossSessionClientFrame | CrossSessionAckFrame;

export type CrossSessionSendFrame = Omit<CrossSessionInboundFrame, 'type'>;

export interface CrossSessionSendOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CrossSessionSocketOptions {
  readonly uid?: number;
  readonly tmpDir?: string;
}

export interface CrossSessionInboxServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface CrossSessionInboxOptions {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly token: string;
  readonly handle: (frame: CrossSessionInboundFrame) => Promise<CrossSessionAckFrame>;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export function encodeCrossSessionFrame(frame: CrossSessionWireFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export class CrossSessionFrameDecoder {
  private buffer = '';

  push(chunk: string): CrossSessionWireFrame[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const frames: CrossSessionWireFrame[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line) as CrossSessionWireFrame);
      } catch {
        continue;
      }
    }
    return frames;
  }
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

export function resolveCrossSessionSocketDir(options: CrossSessionSocketOptions = {}): string {
  if (options.tmpDir !== undefined || options.uid !== undefined) {
    return join(options.tmpDir ?? tmpdir(), `kimi-socks-${options.uid ?? currentUid()}`);
  }
  return (
    process.env[CROSS_SESSION_SOCKET_DIR_ENV] ??
    join(tmpdir(), `kimi-socks-${currentUid()}`)
  );
}

export function resolveCrossSessionSocketPath(
  sessionId: string,
  options: CrossSessionSocketOptions = {},
): string {
  return join(resolveCrossSessionSocketDir(options), `${safeSessionFileName(sessionId)}.sock`);
}

export function ackFromReceiveResult(
  messageId: string,
  result: CrossSessionReceiveResult,
): CrossSessionAckFrame {
  switch (result.kind) {
    case 'delivered':
      return {
        type: 'ack',
        messageId,
        kind: 'delivered',
        delivery: result.delivery,
        truncated: result.truncated,
      };
    case 'held':
      return { type: 'ack', messageId, kind: 'held', truncated: result.truncated };
    case 'refused':
      return {
        type: 'ack',
        messageId,
        kind: 'refused',
        reason: result.reason,
        truncated: result.truncated,
      };
  }
}

function errorAck(messageId: string, error: string): CrossSessionAckFrame {
  return { type: 'ack', messageId, kind: 'error', truncated: false, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokensMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseInboundFrame(raw: CrossSessionWireFrame): CrossSessionInboundFrame | undefined {
  const value = raw as unknown as Record<string, unknown>;
  const messageId = value['messageId'];
  const message = value['message'];
  const from = value['from'];
  if (typeof messageId !== 'string' || messageId.trim().length === 0) return undefined;
  if (typeof message !== 'string') return undefined;
  if (typeof from !== 'object' || from === null) return undefined;
  const peer = from as Record<string, unknown>;
  const sessionId = peer['sessionId'];
  const title = peer['title'];
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return undefined;
  if (title !== undefined && typeof title !== 'string') return undefined;
  const inReplyTo = value['inReplyTo'];
  if (inReplyTo !== undefined && typeof inReplyTo !== 'string') return undefined;
  return {
    type: 'message',
    messageId,
    from: { sessionId, ...(title !== undefined ? { title } : {}) },
    message,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
  };
}

async function lstatOrUndefined(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const existing = await lstatOrUndefined(socketPath);
  if (existing === undefined) return;
  if (existing.isSymbolicLink()) {
    throw new Error(`refusing to use symlink socket path '${socketPath}'`);
  }
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  const existing = await lstatOrUndefined(socketPath);
  if (existing === undefined || existing.isSymbolicLink()) return;
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function startCrossSessionInbox(
  options: CrossSessionInboxOptions,
): Promise<CrossSessionInboxServer> {
  await prepareSocketPath(options.socketPath);

  const connections = new Set<Socket>();
  let closed = false;

  const server: Server = createServer((socket) => {
    connections.add(socket);
    let authenticated = false;
    let completed = false;
    const decoder = new CrossSessionFrameDecoder();

    const send = (frame: CrossSessionAckFrame): void => {
      if (!socket.destroyed) socket.write(encodeCrossSessionFrame(frame));
    };

    const finish = (frame: CrossSessionAckFrame): void => {
      if (completed) return;
      completed = true;
      send(frame);
      socket.end();
    };

    const onFrame = (frame: CrossSessionWireFrame): void => {
      if (completed) return;
      if (frame.type === 'auth') {
        if (typeof frame.token !== 'string' || !tokensMatch(options.token, frame.token)) {
          finish(errorAck('', 'unauthorized'));
          return;
        }
        authenticated = true;
        return;
      }
      if (!authenticated) {
        finish(errorAck('', 'expected auth first'));
        return;
      }
      if (frame.type !== 'message') {
        finish(errorAck('', 'unknown frame type'));
        return;
      }
      const inbound = parseInboundFrame(frame);
      if (inbound === undefined) {
        finish(errorAck('', 'invalid message frame'));
        return;
      }
      void options.handle(inbound).then(
        (ack) => {
          finish(ack);
        },
        (error: unknown) => {
          finish(errorAck(inbound.messageId, errorMessage(error)));
        },
      );
    };

    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk.toString('utf8'))) onFrame(frame);
    });
    socket.on('error', () => {
      connections.delete(socket);
    });
    socket.on('close', () => {
      connections.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      server.on('error', () => {});
      resolve();
    });
  });

  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      server.close();
      throw error;
    }
  }

  return {
    socketPath: options.socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await removeSocketFile(options.socketPath);
    },
  };
}

export async function sendCrossSessionFrame(
  socketPath: string,
  token: string,
  frame: CrossSessionSendFrame,
  options: CrossSessionSendOptions = {},
): Promise<CrossSessionAckFrame> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  return new Promise<CrossSessionAckFrame>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const decoder = new CrossSessionFrameDecoder();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };

    const succeed = (ack: CrossSessionAckFrame): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve(ack);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onAbort = (): void => {
      fail(options.signal?.reason ?? new Error('cross-session send aborted'));
    };

    socket.on('data', (chunk: Buffer) => {
      for (const received of decoder.push(chunk.toString('utf8'))) {
        if (received.type === 'ack') succeed(received);
      }
    });
    socket.on('error', (error: Error) => {
      fail(error);
    });
    socket.on('close', () => {
      fail(new Error('cross-session connection closed before ack'));
    });

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => {
          fail(new Error(`cross-session send timed out after ${timeoutMs}ms`));
        },
        timeoutMs,
      );
      timer.unref();
    }

    socket.write(encodeCrossSessionFrame({ type: 'auth', token }));
    socket.write(
      encodeCrossSessionFrame({
        type: 'message',
        messageId: frame.messageId,
        from: frame.from,
        message: frame.message,
        ...(frame.inReplyTo !== undefined ? { inReplyTo: frame.inReplyTo } : {}),
      }),
    );
  });
}
