/**
 * Termination signal handling for the `kimi web` foreground server.
 *
 * The shutdown sequence itself belongs to `run.ts`; this module owns the signal
 * contract around it: at most one shutdown per process, a notice on stderr
 * (the server logger defaults to `silent`, so without it a wedged shutdown is
 * indistinguishable from a hung terminal), a bounded wait before force-exiting,
 * and the signal's own exit code (130/143) rather than success.
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
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code?: number): void;
}

/** The process and output streams a foreground run reports through. */
export interface LifecycleTargets {
  proc: LifecycleProcess;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ServerTerminationDeps extends LifecycleTargets {
  /** Closes the server and flushes what it still owes. Awaited before exiting. */
  shutdown: (reason: string) => Promise<void>;
}

const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Handle SIGINT/SIGTERM once each: shut the server down, then exit with the
 * signal's code. Returns an uninstall function restoring the default
 * disposition.
 */
export function installServerTerminationHandlers(deps: ServerTerminationDeps): () => void {
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

  for (const signal of TERMINATION_SIGNALS) {
    const listener = (): void => {
      void terminate(signal);
    };
    listeners.set(signal, listener);
    deps.proc.once(signal, listener);
  }

  return uninstall;
}
