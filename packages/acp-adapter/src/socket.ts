/**
 * Socket transport for the ACP adapter.
 *
 * `runAcpServerOnSocket` serves the ACP JSON-RPC protocol over a Unix
 * domain socket (POSIX) or a Windows named pipe — the same `node:net`
 * API covers both — so several editor clients can share one long-lived
 * agent process instead of each spawning its own stdio child. Every
 * accepted connection gets its own {@link AcpServer} over the shared
 * {@link KimiHarness}; sessions are multiplexed by `sessionId` inside
 * the server, so the only per-connection state is the JSON-RPC
 * connection itself.
 */

import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { Duplex } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { runAcpServerWithStream, type AcpServerRunnerOptions } from './server';

/**
 * Default ceiling on concurrent socket clients. Every accepted
 * connection drives a full {@link AcpServer} over the shared harness, so
 * an unbounded accept loop lets any local process exhaust memory and
 * file descriptors. 64 sits far above the handful of editors this
 * transport exists for while still bounding the blast radius.
 */
const DEFAULT_MAX_SOCKET_CONNECTIONS = 64;

/**
 * Serve ACP over a Unix domain socket / Windows named pipe until
 * SIGINT or SIGTERM triggers a drain.
 *
 * The returned promise resolves only after the server has stopped
 * accepting, every live connection is torn down, and the shared
 * harness is closed — the socket-mode analogue of `await conn.closed`
 * in stdio mode. Unlike stdio mode there is no "natural EOF" exit: a
 * socket server has no single client whose disconnect should end the
 * process, so a signal is the only shutdown trigger.
 *
 * No `redirectConsoleToStderr()` here — stdout is not the protocol
 * channel in socket mode, so libraries logging to stdout cannot
 * corrupt the wire.
 */
export async function runAcpServerOnSocket(
  harness: KimiHarness,
  opts: AcpServerRunnerOptions & {
    socketPath: string;
    /**
     * Upper bound on concurrent client connections. Connections past the
     * cap are refused immediately instead of starting another server.
     * Defaults to 64.
     */
    maxConnections?: number;
  },
): Promise<void> {
  const { socketPath } = opts;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_SOCKET_CONNECTIONS;
  // Windows named pipes live in a dedicated kernel namespace, not the
  // filesystem — mkdir/unlink/chmod are meaningless (and fail) there,
  // and the caller passes a `\\.\pipe\...` path.
  const isPosix = process.platform !== 'win32';

  if (isPosix) {
    // 0700: the socket is an unauthenticated local RPC endpoint, so
    // the directory must not be traversable by other users.
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    // A crashed previous run leaves the socket file behind and
    // listen() would fail with EADDRINUSE — remove it first.
    // ENOENT means nothing stale, the common case.
    try {
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else {
    // The 0700 directory + 0600 socket below are the entire access
    // boundary on POSIX, and a named pipe has no equivalent: it is
    // created with the default DACL, so any account on the machine can
    // open this unauthenticated agent RPC endpoint. Warn rather than
    // let the POSIX guarantees be assumed to hold here.
    log.warn('acp: named pipe has no filesystem access boundary', { socketPath });
  }

  const liveSockets = new Set<Socket>();
  const driverPromises = new Set<Promise<void>>();

  const server = createServer((socket) => {
    if (liveSockets.size >= maxConnections) {
      // Refuse before any per-connection work: accepting here would boot
      // another server over the shared harness, which is exactly how an
      // unbounded accept loop turns into a local resource-exhaustion
      // vector.
      log.warn('acp: socket connection limit reached, refusing client', {
        socketPath,
        maxConnections,
      });
      socket.destroy();
      return;
    }
    liveSockets.add(socket);
    // The ACP SDK speaks Web ReadableStream/WritableStream; bridge the
    // Node socket once and hand the pair to the same per-connection
    // driver stdio mode uses.
    const { readable, writable } = Duplex.toWeb(socket);
    const stream = ndJsonStream(writable, readable);
    const driver = runAcpServerWithStream(harness, stream, {
      agentInfo: opts.agentInfo,
      terminalAuthEnv: opts.terminalAuthEnv,
      terminalAuthLegacyCommand: opts.terminalAuthLegacyCommand,
      slashCommands: opts.slashCommands,
    }).then(
      () => {
        liveSockets.delete(socket);
        log.info('acp: socket client disconnected', { socketPath });
      },
      (error: unknown) => {
        // A single misbehaving client must never take down the shared
        // server — log with context, drop the connection, and keep
        // serving the rest. The rejection is consumed here so it can't
        // surface as an unhandled rejection.
        liveSockets.delete(socket);
        log.error('acp: socket client connection failed', {
          socketPath,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      },
    );
    driverPromises.add(driver);
    void driver.finally(() => driverPromises.delete(driver));
  });

  const onServerError = (error: Error): void => {
    log.error('acp: socket server error', { socketPath, error: error.message });
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      // Swap the startup rejector for a permanent handler: a post-listen
      // 'error' must not hit a settled promise, and with NO 'error'
      // listener left Node re-throws the event — which would take down
      // the shared server and every client on it.
      server.off('error', reject);
      server.on('error', onServerError);
      resolve();
    });
  });

  if (isPosix) {
    // Socket files inherit the umask (often group/world-accessible),
    // but this endpoint accepts full agent RPC with no handshake auth,
    // so tighten to owner-only — the socket-mode analogue of stdio's
    // inherited-fd privacy.
    await chmod(socketPath, 0o600);
  }

  const signals = opts.signals ?? process;

  // Resolved at the END of cleanup so the main flow (and thus the
  // returned promise) only settles once the drain has fully finished.
  let resolveDrained: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  let cleanedUp = false;
  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    // Idempotent: duplicate signals and the `finally` re-entry must
    // not close the harness twice. `cleanedUp` is checked-and-set
    // synchronously so concurrent invocations cannot race.
    if (cleanedUp) return;
    cleanedUp = true;
    if (signal) {
      log.info('acp: received signal, draining socket server', { signal, socketPath });
    }
    // Stop accepting first, then destroy live sockets so their
    // per-connection runs settle and `server.close` can complete.
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    for (const socket of liveSockets) {
      socket.destroy();
    }
    liveSockets.clear();
    await closed;
    // The harness is shared across every connection, so it must not be
    // torn down while a per-connection run is still using it — wait for
    // each destroyed connection's driver to settle first.
    await Promise.allSettled(driverPromises);
    try {
      // Process-level, not per-connection: the harness is shared
      // across every client, so closing it is a shutdown concern.
      await harness.close();
    } catch (error) {
      // The process is exiting either way; log so the diagnostic is
      // preserved rather than disappearing into a thrown promise.
      log.error('acp: harness close failed during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (isPosix) {
      // Best-effort: a missing file at this point is fine (something
      // else already removed it), anything else is worth a warning.
      try {
        await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('acp: failed to remove socket file during shutdown', {
            socketPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    resolveDrained();
  };

  const onSigint = (): void => {
    void cleanup('SIGINT');
  };
  const onSigterm = (): void => {
    void cleanup('SIGTERM');
  };
  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  try {
    await drained;
  } finally {
    // Uninstall BEFORE the final cleanup so a second SIGINT (a user
    // double-tapping Ctrl-C while the drain is in flight) propagates
    // to the default handler and force-kills the process — `.once`
    // already consumed the first delivery, and the explicit `off`
    // keeps repeat invocations from tests from polluting the
    // process-wide listener set.
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await cleanup();
  }
}
