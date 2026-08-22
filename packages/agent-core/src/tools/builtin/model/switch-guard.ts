/**
 * Context-window switch guard.
 *
 * Switching the active model mid-session replaces the context window under an
 * existing conversation. The guard only permits switches that do not shrink
 * the window: a target window at least as large as the current one keeps the
 * existing context inside the new budget. A window of `<= 0` means the size is
 * unknown (kosong reports `0` for "unknown"), and unknown windows are treated
 * as not switchable so the session never drops context on a guess.
 */

/**
 * Whether a target model's context window can replace the current one.
 *
 * Returns false when either window is unknown (`<= 0`) or the target would
 * shrink the window below the current conversation's budget.
 */
export function canSwitchModel(targetMaxContext: number, currentMaxContext: number): boolean {
  if (targetMaxContext <= 0 || currentMaxContext <= 0) return false;
  return targetMaxContext >= currentMaxContext;
}

/**
 * True when the configured planning model is also the default model. Plan mode
 * then keeps the default active on exit, so there is nothing to restore.
 */
export function planningModelMatchesDefault(
  planning: string | undefined,
  defaultModel: string | undefined,
): boolean {
  return planning === defaultModel;
}
