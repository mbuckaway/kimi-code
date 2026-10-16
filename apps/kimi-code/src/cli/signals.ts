/**
 * Signal-to-exit-code mapping shared by the CLI's termination paths.
 *
 * Leaf module on purpose: `cli/sub/**` must not import the headless runner to
 * reuse one line, and tests that need this behaviour must not inherit the SDK
 * mock bag that `run-prompt.ts` carries.
 */

/**
 * Shell convention: 128 + the signal number.
 *
 * Supervisors key off this to tell a signal-driven exit apart from a crash, so
 * a terminated run must never report success.
 */
export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}
