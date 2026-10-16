/**
 * Signal handling for the `kimi web` foreground server.
 *
 * The shutdown and reload sequences themselves belong to `run.ts`; this module
 * owns the signal contract around them: at most one shutdown per process, a
 * notice on stderr (the server logger defaults to `silent`, so without it a
 * wedged shutdown is indistinguishable from a hung terminal), a bounded wait
 * before force-exiting, the signal's own exit code (130/143) rather than
 * success, and a SIGHUP that reloads config without ever taking the server down.
 *
 * The exit code is committed to the process before the shutdown is awaited, and
 * the force-exit deadline keeps the event loop alive. Both are needed because a
 * teardown can wedge in two shapes: the awaited work holds no ref'd handle, so
 * the loop drains and Node exits with whatever `exitCode` says; or handles stay
 * open while the work never settles, so only a deadline ends the run.
 */

import { flushTelemetrySync } from '@moonshot-ai/kimi-telemetry';

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
  /**
   * `process.exitCode`, typed as Node declares it: what the process exits with
   * when the event loop drains instead of being exited by hand.
   */
  exitCode: number | string | null | undefined;
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
  /**
   * The parser's own message when a `[server]` value written after startup could
   * not be re-read. The engine reload succeeded in this case, so it is reported
   * as a missing advisory — never as a reload that failed.
   */
  readonly restartAdvisoryError?: string;
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

  function forceExit(code: number): void {
    deps.stderr.write(`Force-exiting after ${WEB_SHUTDOWN_FORCE_EXIT_MS}ms\n`);
    flushTelemetrySync();
    deps.proc.exit(code);
  }

  async function terminate(signal: NodeJS.Signals): Promise<void> {
    const code = signalExitCode(signal);
    deps.stderr.write(`Shutting down (${signal})…\n`);
    // Stop intercepting before the first await: a second signal, of either
    // kind, means "stop waiting" and must reach Node's default disposition
    // instead of queueing a second shutdown behind the wedged first one.
    uninstall();
    // Commit the code before awaiting `shutdown`. A teardown stalled on a promise
    // with nothing ref'd behind it — a retirement drain that never finishes, a
    // hung `onShutdown` hook — lets the event loop drain, and Node exits with
    // this value. Leaving it unset reports a wedged shutdown as success.
    deps.proc.exitCode = code;
    // Ref'd on purpose, unlike the headless force-exit backstop, which must not
    // keep a finished run alive: this deadline has to hold the loop open so it
    // can fire for the other wedge shape — handles still ref'd, work never
    // settling. `run-prompt.ts:raceWithTimeout` keeps its timer ref'd likewise.
    const deadline = setTimeout(() => {
      forceExit(code);
    }, WEB_SHUTDOWN_FORCE_EXIT_MS);
    try {
      await deps.shutdown(signal);
    } finally {
      // Either `shutdown` finished and this cancels a deadline no longer
      // needed, or the deadline already exited the process and this is not
      // reached.
      clearTimeout(deadline);
      deps.proc.exit(code);
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
    if (report.restartAdvisoryError !== undefined) {
      // The engine applied the reload, so this is not a reload failure: only the
      // `[server]` comparison could not run. Claiming the previous values were
      // kept, or that config writes are blocked, would report a state the engine
      // is not in.
      deps.stdout.write(
        `restart advisory unavailable: ${report.restartAdvisoryError} — fix the value to see which [server] keys need a restart\n`,
      );
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
