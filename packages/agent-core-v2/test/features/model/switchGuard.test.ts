import { describe, expect, it } from 'vitest';

import { canSwitchModel, planningModelMatchesDefault } from '#/features/model/switchGuard';

describe('canSwitchModel', () => {
  it('allows switching to a model with a larger context window', () => {
    expect(canSwitchModel(200_000, 128_000)).toBe(true);
  });

  it('allows switching to a model with an equal context window', () => {
    expect(canSwitchModel(128_000, 128_000)).toBe(true);
  });

  it('rejects switching to a model with a smaller context window', () => {
    expect(canSwitchModel(64_000, 128_000)).toBe(false);
  });

  it('treats an unknown target context window (<= 0) as not switchable', () => {
    expect(canSwitchModel(0, 128_000)).toBe(false);
    expect(canSwitchModel(-1, 128_000)).toBe(false);
  });

  it('treats an unknown current context window (<= 0) as not switchable', () => {
    expect(canSwitchModel(128_000, 0)).toBe(false);
    expect(canSwitchModel(128_000, -1)).toBe(false);
  });

  it('treats two unknown context windows as not switchable', () => {
    expect(canSwitchModel(0, 0)).toBe(false);
  });
});

describe('planningModelMatchesDefault', () => {
  it('returns true when the planning context window equals the default', () => {
    expect(planningModelMatchesDefault(200_000, 200_000)).toBe(true);
  });

  it('returns false when the planning context window differs from the default', () => {
    expect(planningModelMatchesDefault(128_000, 200_000)).toBe(false);
    expect(planningModelMatchesDefault(200_000, 128_000)).toBe(false);
  });
});
