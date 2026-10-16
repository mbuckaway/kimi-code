/**
 * Signal handling for the `kimi web` foreground server.
 *
 * The shutdown and reload sequences themselves belong to `run.ts`; this module
 * owns the signal contract around them: at most one shutdown per process, a
 * notice on stderr (the server logger defaults to `silent`, so without it a
 * wedged shutdown is indistinguishable from a hung terminal), a bounded wait
 * before force-exiting, the signal's own exit code (130/143) rather than
 * success, and a SIGHUP that reloads config without ever taking the server down.
 */

import { flushTelemetrySync } from '@moonshot-ai/kimi-telemetry';

import { scheduleHeadlessForceExit } from '#/cli/headless-exit';
import { signalExitCode } from '#/cli/signals';
import { WEB_SHUTDOWN_FORCE_EXIT_MS } from '#/constant/app';

/**
 * Process surface the handlers need, declared structurally with loose members:
 * `Pick<NodeJS.Process, …>` would not work because `Process.once` carries
 * fourteen overloads returning `this` and `Process.exit` returns `never`, so
 * neither a test double nor `PromptProcess` could satisfy it.
 */
export interface LifecycleProcess {
  /** One-shot registration, used by the termination signals. */
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  /** Persistent registration, used by SIGHUP: a reload leaves the server up. */
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code?: number): void;
}

/** The process and output streams a foreground run reports through. */
export interface LifecycleTargets {
  proc: LifecycleProcess;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ServerSignalDeps extends LifecycleTargets {
  /** Closes the server and flushes what it still owes. Awaited before exiting. */
  shutdown: (reason: string) => Promise<void>;
  /**
   * Re-reads `config.toml` through the running engine and reports the facts.
   * The wording is this module's job, so a caller never formats a line.
   */
  reload: () => Promise<ConfigReloadReport>;
}

/** What a config reload did, without any user-facing wording attached. */
export interface ConfigReloadReport {
  /** Engine domains whose effective value changed, already deduped. */
  readonly changedDomains: readonly string[];
  /** The engine's own message when the file could not be read. */
  readonly error?: string;
  /** `[server]` keys that differ from the running values and need a restart. */
  readonly restartKeys: readonly string[];
}

const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * SIGHUP is only a reload signal where it exists as one. On Windows it means
 * "the console window is closing" and Node is terminated about ten seconds
 * later regardless, and nothing can send it, so intercepting it would buy
 * nothing. The termination signals stay registered everywhere.
 */
const RELOAD_SIGNAL: NodeJS.Signals = 'SIGHUP';

/**
 * Handle SIGINT/SIGTERM once each and SIGHUP as many times as it arrives.
 * Returns an uninstall function restoring the default disposition.
 */
export function installServerSignalHandlers(deps: ServerSignalDeps): () => void {
  const listeners = new Map<NodeJS.Signals, () => void>();

  const uninstall = (): void => {
    for (const [signal, listener] of listeners) {
      deps.proc.off(signal, listener);
    }
    listeners.clear();
  };

  const forceExitCode = (signal: NodeJS.Signals): number => {
    deps.stderr.write(`Force-exiting after ${WEB_SHUTDOWN_FORCE_EXIT_MS}ms\n`);
    flushTelemetrySync();
    return signalExitCode(signal);
  };

  async function terminate(signal: NodeJS.Signals): Promise<void> {
    deps.stderr.write(`Shutting down (${signal})…\n`);
    // Stop intercepting before the first await: a second signal, of either
    // kind, means "stop waiting" and must reach Node's default disposition
    // instead of queueing a second shutdown behind the wedged first one.
    uninstall();
    const forceExit = scheduleHeadlessForceExit(
      deps.proc,
      () => forceExitCode(signal),
      WEB_SHUTDOWN_FORCE_EXIT_MS,
    );
    try {
      await deps.shutdown(signal);
    } finally {
      // Either `shutdown` finished and this cancels a watchdog that is no
      // longer needed, or the watchdog already fired and this is a no-op.
      clearTimeout(forceExit);
      deps.proc.exit(signalExitCode(signal));
    }
  }

  // A reload re-walks every config subscriber in the engine, so a storm of
  // SIGHUPs must coalesce rather than stack.
  let reloading = false;

  function reportReload(report: ConfigReloadReport): void {
    if (report.error !== undefined) {
      // The engine kept the values it already had, and refuses to write config
      // until the file parses again — both belong in the same line as the
      // failure, or the user reads a success they did not get.
      deps.stdout.write(
        `config reload failed: ${report.error} — kept previous values; ` +
          'config writes are blocked until the file is fixed\n',
      );
      return;
    }
    const changed =
      report.changedDomains.length === 0
        ? 'no changes'
        : report.changedDomains.join(', ');
    deps.stdout.write(`config reloaded: ${changed}\n`);
    if (report.restartKeys.length > 0) {
      deps.stdout.write(`restart required for: ${report.restartKeys.join(', ')}\n`);
    }
  }

  function onReload(): void {
    if (reloading) return;
    reloading = true;
    // Never a bare `void reload()`: kap-server installs its process rejection
    // handlers only once it is listening, and at the default `silent` log level
    // a rejection here would be invisible.
    deps
      .reload()
      .then(
        (report) => reportReload(report),
        (error: unknown) =>
          reportReload({
            changedDomains: [],
            error: error instanceof Error ? error.message : String(error),
            restartKeys: [],
          }),
      )
      .finally(() => {
        reloading = false;
      });
  }

  for (const signal of TERMINATION_SIGNALS) {
    const listener = (): void => {
      void terminate(signal);
    };
    listeners.set(signal, listener);
    deps.proc.once(signal, listener);
  }

  if (process.platform !== 'win32') {
    listeners.set(RELOAD_SIGNAL, onReload);
    // `on`, not `once`: a reload leaves the server running, so every SIGHUP has
    // to be answered.
    deps.proc.on(RELOAD_SIGNAL, onReload);
  }

  return uninstall;
}
