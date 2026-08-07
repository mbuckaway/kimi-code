/**
 * Socket transport for the v2-native ACP server.
 *
 * `runAcpServerOnSocket` serves the ACP JSON-RPC protocol over a Unix
 * domain socket (POSIX) or a Windows named pipe — the same `node:net` API
 * covers both — so several editor clients can share one long-lived server
 * process instead of each spawning its own stdio child.
 *
 * Unlike the legacy `acp-adapter` (one shared `KimiHarness` across every
 * connection), each accepted socket boots its OWN `agent-core-v2` core via
 * {@link runAcpServerWithStream}. `IAcpConnection` is an App-scope
 * singleton whose reverse-RPC bind is last-writer-wins, so one core shared
 * across connections would let a later client silently steal an earlier
 * client's fs/terminal reverse-RPC channel. Every client gets its own core
 * instead; all of them read and write the same on-disk session store under
 * `homeDir`.
 */

import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { Duplex } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';

import { log } from './log';
import { runAcpServerWithStream, type RunAcpServerOptions, type RunningAcpServer } from './start';

/**
 * Default ceiling on concurrent socket clients. Every accepted connection
 * boots its own `agent-core-v2` core, so an unbounded accept loop lets any
 * local process exhaust memory and file descriptors. 64 sits far above the
 * handful of editors this transport exists for while still bounding the
 * blast radius.
 */
const DEFAULT_MAX_SOCKET_CONNECTIONS = 64;

export interface AcpSocketServerOptions extends Omit<RunAcpServerOptions, 'input' | 'output'> {
  readonly socketPath: string;
  /**
   * Upper bound on concurrent client connections. Connections past the cap
   * are refused immediately instead of booting another core. Defaults to
   * 64.
   */
  readonly maxConnections?: number;
  /** @internal test seam, same shape as acp-adapter's */
  readonly signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
}

/**
 * Serve ACP over a Unix domain socket / Windows named pipe until SIGINT or
 * SIGTERM triggers a drain.
 *
 * The returned promise resolves only after the server has stopped
 * accepting, every live connection's per-connection core is closed, and
 * the socket file is removed — the socket-mode analogue of `await
 * conn.closed` in stdio mode. A socket server has no single client whose
 * disconnect should end the process, so a signal is the only shutdown
 * trigger.
 *
 * No `redirectConsoleToStderr()` here — stdout is not the protocol channel
 * in socket mode, so a stray `console.*` write from a dependency cannot
 * corrupt the wire.
 */
export async function runAcpServerOnSocket(opts: AcpSocketServerOptions): Promise<void> {
  const { socketPath, maxConnections: maxConnectionsOpt, signals: signalsOpt, ...serverOpts } = opts;
  const maxConnections = maxConnectionsOpt ?? DEFAULT_MAX_SOCKET_CONNECTIONS;
  // Windows named pipes live in a dedicated kernel namespace, not the
  // filesystem — mkdir/unlink/chmod are meaningless (and fail) there, and
  // the caller passes a `\\.\pipe\...` path.
  const isPosix = process.platform !== 'win32';

  if (isPosix) {
    // 0700: the socket is an unauthenticated local RPC endpoint, so the
    // directory must not be traversable by other users.
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    // A crashed previous run leaves the socket file behind and listen()
    // would fail with EADDRINUSE — remove it first. ENOENT means nothing
    // stale, the common case.
    try {
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else {
    // The 0700 directory + 0600 socket below are the entire access boundary
    // on POSIX, and a named pipe has no equivalent: it is created with the
    // default DACL, so any account on the machine can open this
    // unauthenticated agent RPC endpoint. Warn rather than let the POSIX
    // guarantees be assumed to hold here.
    log.warn('acp: named pipe has no filesystem access boundary', { socketPath });
  }

  const liveSockets = new Set<Socket>();
  const driverPromises = new Set<Promise<void>>();

  const server = createServer((socket) => {
    if (liveSockets.size >= maxConnections) {
      // Refuse before any per-connection work: accepting here would boot
      // another full core, which is exactly how an unbounded accept loop
      // turns into a local resource-exhaustion vector.
      log.warn('acp: socket connection limit reached, refusing client', {
        socketPath,
        maxConnections,
      });
      socket.destroy();
      return;
    }
    liveSockets.add(socket);
    const driver = (async (): Promise<void> => {
      let running: RunningAcpServer | undefined;
      try {
        // The ACP SDK speaks Web ReadableStream/WritableStream; bridge the
        // Node socket once and boot a per-connection core over it (see the
        // module doc for why each connection gets its own core).
        const { readable, writable } = Duplex.toWeb(socket);
        const stream = ndJsonStream(writable, readable);
        running = await runAcpServerWithStream(stream, serverOpts);
        await running.conn.closed;
      } catch (error) {
        // A single misbehaving client (including a failed engine bootstrap)
        // must never take down the shared server — log with context, drop
        // the connection, and keep serving the rest.
        log.error('acp: socket client connection failed', {
          socketPath,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      } finally {
        liveSockets.delete(socket);
        // Memoized on `RunningAcpServer` — safe even though `conn.closed`
        // already triggers a close internally.
        await running?.close();
      }
    })();
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
      // 'error' must not hit a settled promise, and with NO 'error' listener
      // left Node re-throws the event — which would take down the shared
      // server and every client on it.
      server.off('error', reject);
      server.on('error', onServerError);
      resolve();
    });
  });

  if (isPosix) {
    // Socket files inherit the umask (often group/world-accessible), but
    // this endpoint accepts full agent RPC with no handshake auth, so
    // tighten to owner-only — the socket-mode analogue of stdio's
    // inherited-fd privacy.
    await chmod(socketPath, 0o600);
  }

  const signals = signalsOpt ?? process;

  // Resolved at the END of cleanup so the main flow (and thus the returned
  // promise) only settles once the drain has fully finished.
  let resolveDrained: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  let cleanedUp = false;
  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    // Idempotent: duplicate signals and the `finally` re-entry must not run
    // the drain twice. `cleanedUp` is checked-and-set synchronously so
    // concurrent invocations cannot race.
    if (cleanedUp) return;
    cleanedUp = true;
    if (signal) {
      log.info('acp: received signal, draining socket server', { signal, socketPath });
    }
    // Stop accepting first, then destroy live sockets so their
    // per-connection cores settle and `server.close` can complete.
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    for (const socket of liveSockets) {
      socket.destroy();
    }
    liveSockets.clear();
    await closed;
    // Each connection's close() flushes that core's own append-log
    // write-behind — wait for every one so no in-flight write is dropped
    // on shutdown.
    await Promise.allSettled(driverPromises);
    if (isPosix) {
      // Best-effort: a missing file at this point is fine (something else
      // already removed it), anything else is worth a warning.
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
    // double-tapping Ctrl-C while the drain is in flight) propagates to the
    // default handler and force-kills the process — `.once` already
    // consumed the first delivery, and the explicit `off` keeps repeat
    // invocations from tests from polluting the process-wide listener set.
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await cleanup();
  }
}
