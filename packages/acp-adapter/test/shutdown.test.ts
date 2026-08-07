import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { runAcpServer } from '../src/server';
import { runAcpServerOnSocket } from '../src/socket';

interface CloseCounterHarness {
  harness: KimiHarness;
  closeCalls: () => number;
}

/**
 * Minimal harness stub. Phase 11's shutdown wiring only touches
 * {@link KimiHarness.close}; the other harness surface is exercised in
 * sibling tests (`session-new`, `session-load`, etc.) and is irrelevant
 * here. Each close call increments a counter so we can assert
 * idempotency on signal+natural-close interleavings.
 */
function makeCloseCounterHarness(opts: { throwOnClose?: boolean } = {}): CloseCounterHarness {
  let calls = 0;
  const harness = {
    close: async (): Promise<void> => {
      calls += 1;
      if (opts.throwOnClose) {
        throw new Error('intentional close failure for test');
      }
    },
  } as unknown as KimiHarness;
  return { harness, closeCalls: () => calls };
}

/**
 * Tear off the JSON-RPC connection by ending stdin so
 * `AgentSideConnection.closed` resolves and `runAcpServer` returns.
 * Used by the natural-close test path; the signal-path test forces
 * cleanup BEFORE this end fires.
 */
function endInput(input: PassThrough): void {
  input.end();
}

describe('runAcpServer graceful shutdown', () => {
  it('calls harness.close() exactly once when SIGINT fires before natural close', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    // Drain output so the agent side never backpressures.
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    // Give the connection a tick to start, then fire SIGINT.
    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGINT');

    // The signal-driven cleanup runs synchronously after the tick but
    // doesn't itself end the stream — close the input so the
    // connection actually settles.
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('calls harness.close() exactly once on natural close (no signal)', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    // Natural close: end stdin immediately.
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('treats SIGTERM the same as SIGINT and stays idempotent if both fire', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGTERM');
    signals.emit('SIGINT'); // duplicate signal — must NOT call close again

    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    // SIGTERM and SIGINT collapse to a single close call thanks to the
    // `cleanedUp` latch. The natural-close path in `finally` also
    // re-enters `cleanup()` and must be a no-op.
    expect(closeCalls()).toBe(1);
  });

  it('uninstalls listeners even when harness.close() throws', async () => {
    // The process is exiting anyway; the implementation must NOT let a
    // throwing `close()` leak the SIGINT/SIGTERM handlers.
    const { harness, closeCalls } = makeCloseCounterHarness({ throwOnClose: true });
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => undefined);

    const run = runAcpServer(harness, { input, output, signals });

    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));
    endInput(input);
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

/**
 * Unique socket path per test: a filesystem path under the OS temp dir
 * on POSIX, a named-pipe path on Windows (the same `node:net` API
 * serves both). The id is truncated because macOS caps unix-socket
 * paths at 104 bytes and the temp-dir prefix already eats half of it.
 */
function makeSocketPath(): string {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\acp-shutdown-test-${id}`
    : join(tmpdir(), `acp-sd-${id}.sock`);
}

/**
 * Connect once the server is actually accepting. `runAcpServerOnSocket`
 * has no readiness callback, so tests poll: a refused connect just
 * means `listen()` hasn't completed yet.
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

describe('runAcpServerOnSocket graceful shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls harness.close() exactly once on SIGINT and stops accepting', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const socketPath = makeSocketPath();

    const run = runAcpServerOnSocket(harness, { socketPath, signals });

    // Readiness probe: proves the server accepted at least one client
    // before the signal lands.
    const probe = await connectWhenReady(socketPath);
    probe.destroy();

    signals.emit('SIGINT');
    await run;

    expect(closeCalls()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);

    // The listener is gone: a fresh connect must be refused.
    const late = createConnection(socketPath);
    await expect(once(late, 'connect')).rejects.toThrow(/ENOENT|ECONNREFUSED/);
    late.destroy();
  });

  it.skipIf(process.platform === 'win32')(
    'removes the socket file from disk on SIGINT',
    async () => {
      const { harness } = makeCloseCounterHarness();
      const signals = new EventEmitter();
      const socketPath = makeSocketPath();

      const run = runAcpServerOnSocket(harness, { socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      expect(existsSync(socketPath)).toBe(true);
      probe.destroy();

      signals.emit('SIGINT');
      await run;

      expect(existsSync(socketPath)).toBe(false);
    },
  );

  it('stays idempotent when SIGTERM and SIGINT both fire', async () => {
    const { harness, closeCalls } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const socketPath = makeSocketPath();

    const run = runAcpServerOnSocket(harness, { socketPath, signals });

    const probe = await connectWhenReady(socketPath);
    probe.destroy();

    signals.emit('SIGTERM');
    signals.emit('SIGINT'); // duplicate — the latch must collapse both
    await run;

    expect(closeCalls()).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'rebinds when a stale file occupies the socket path',
    async () => {
      const socketPath = makeSocketPath();
      // Simulate a crashed previous run: a plain leftover file where
      // the socket should be. listen() would fail with EADDRINUSE if
      // the server didn't remove it first.
      await writeFile(socketPath, 'stale');

      const { harness, closeCalls } = makeCloseCounterHarness();
      const signals = new EventEmitter();

      const run = runAcpServerOnSocket(harness, { socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      expect((await stat(socketPath)).isSocket()).toBe(true);
      probe.destroy();

      signals.emit('SIGINT');
      await run;

      expect(closeCalls()).toBe(1);
      expect(existsSync(socketPath)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates the socket file with owner-only 0600 permissions',
    async () => {
      const socketPath = makeSocketPath();
      const { harness } = makeCloseCounterHarness();
      const signals = new EventEmitter();

      const run = runAcpServerOnSocket(harness, { socketPath, signals });

      const probe = await connectWhenReady(socketPath);
      const mode = (await stat(socketPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      probe.destroy();

      signals.emit('SIGINT');
      await run;
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects when clearing a stale socket path fails with anything but ENOENT',
    async () => {
      const socketPath = makeSocketPath();
      // A directory at the socket path makes the startup unlink fail with
      // EPERM/EISDIR — the class of error that must NOT be swallowed the way
      // "nothing stale here" (ENOENT) is.
      await mkdir(socketPath);
      const { harness, closeCalls } = makeCloseCounterHarness();
      const signals = new EventEmitter();

      try {
        await expect(runAcpServerOnSocket(harness, { socketPath, signals })).rejects.toThrow(
          /EPERM|EISDIR/,
        );

        // The failure happened before any wiring: no harness ownership taken,
        // no signal handlers left behind.
        expect(closeCalls()).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
      } finally {
        await rm(socketPath, { recursive: true, force: true });
      }
    },
  );

  it('waits for in-flight connection drivers before closing the shared harness', async () => {
    const order: string[] = [];
    const harness = {
      close: async (): Promise<void> => {
        order.push('harness-close');
      },
    } as unknown as KimiHarness;
    // The per-connection driver announces its own settlement; the harness is
    // shared, so it must not be torn down while a driver is still running.
    vi.spyOn(log, 'info').mockImplementation((message: string) => {
      if (message === 'acp: socket client disconnected') order.push('driver-settled');
    });
    vi.spyOn(log, 'error').mockImplementation((message: string) => {
      if (message === 'acp: socket client connection failed') order.push('driver-settled');
    });
    const signals = new EventEmitter();
    const socketPath = makeSocketPath();

    const run = runAcpServerOnSocket(harness, { socketPath, signals });

    // Left connected on purpose: the drain has to destroy it and then wait
    // for that connection's run to finish.
    const probe = await connectWhenReady(socketPath);
    probe.on('error', () => undefined);

    signals.emit('SIGINT');
    await run;

    expect(order).toEqual(['driver-settled', 'harness-close']);
    probe.destroy();
  });

  it('warns that a Windows named pipe carries no filesystem access boundary', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { harness } = makeCloseCounterHarness();
    const signals = new EventEmitter();
    const socketPath = makeSocketPath();
    const realPlatform = process.platform;

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let run: Promise<void>;
    try {
      // The platform check (and the warning) happen before the first await,
      // so the real platform can go back immediately — everything after this
      // point runs on the host's own filesystem semantics.
      run = runAcpServerOnSocket(harness, { socketPath, signals });
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
  });
});
