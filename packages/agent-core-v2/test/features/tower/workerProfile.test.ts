import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { TOWER_WORKER_PROFILE_DEF } from '#/features/tower/workerProfile';
import '#/session/agentLifecycle/profile/profiles';

function builtinProfile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('tower-worker profile', () => {
  it('gives tower-worker the coder tools (minus AgentSwarm and supermoon mode) plus the six shared tower tools', () => {
    const coder = builtinProfile('coder');
    const tools = TOWER_WORKER_PROFILE_DEF.tools ?? [];

    for (const name of coder.tools ?? []) {
      if (
        name === 'AgentSwarm' ||
        name === 'EnterSupermoonMode' ||
        name === 'ExitSupermoonMode'
      ) {
        continue;
      }
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain('AgentSwarm');
    expect(tools).not.toContain('EnterSupermoonMode');
    expect(tools).not.toContain('ExitSupermoonMode');
    expect(TOWER_WORKER_PROFILE_DEF.subagents).toEqual(['explore', 'plan']);
    for (const name of [
      'TowerSend',
      'TowerInbox',
      'TowerFinding',
      'TowerReview',
      'TowerMission',
      'TowerStatus',
    ]) {
      expect(tools).toContain(name);
    }
    for (const name of ['TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerTeardown']) {
      expect(tools).not.toContain(name);
    }
  });

  it('keeps the coder summary policy and whenToUse', () => {
    const coder = builtinProfile('coder');
    expect(TOWER_WORKER_PROFILE_DEF.summaryPolicy).toEqual(coder.summaryPolicy);
    expect(TOWER_WORKER_PROFILE_DEF.summaryPolicy).toBeDefined();
    expect(TOWER_WORKER_PROFILE_DEF.whenToUse).toBe(coder.whenToUse);
  });
});
