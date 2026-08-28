export function canSwitchModel(targetMaxContext: number, currentMaxContext: number): boolean {
  if (targetMaxContext <= 0 || currentMaxContext <= 0) return false;
  return targetMaxContext >= currentMaxContext;
}

export function planningModelMatchesDefault(
  planningMaxContext: number,
  defaultMaxContext: number,
): boolean {
  return planningMaxContext === defaultMaxContext;
}
