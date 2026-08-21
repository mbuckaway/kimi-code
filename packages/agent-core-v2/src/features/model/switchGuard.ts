/**
 * Guard predicates for context-window-safe model switching.
 *
 * A switch from the current model to a target model is only safe when the
 * target's context window is at least as large as the current model's; an
 * unknown window (<= 0) is treated as unsafe so callers surface a clear error
 * instead of shrinking the agent's working context.
 */
export function canSwitchModel(targetMaxContext: number, currentMaxContext: number): boolean {
  if (targetMaxContext <= 0 || currentMaxContext <= 0) return false;
  return targetMaxContext >= currentMaxContext;
}

/**
 * A planning model may only be assigned when its context window exactly
 * matches the default model's, so entering plan mode never changes the
 * agent's working context budget.
 */
export function planningModelMatchesDefault(
  planningMaxContext: number,
  defaultMaxContext: number,
): boolean {
  return planningMaxContext === defaultMaxContext;
}
