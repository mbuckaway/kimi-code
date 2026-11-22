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
  it('gives tower-worker the coder tools minus delegation, planning modes, and supermoon mode, plus the seven shared tower tools', () => {
    const coder = builtinProfile('coder');
    const tools = TOWER_WORKER_PROFILE_DEF.tools ?? [];

    const notWorkerTools = new Set([
      'Agent',
      'AgentSwarm',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterSupermoonMode',
      'ExitSupermoonMode',
      'SendMessage',
      'ListAgents',
      'BroadcastMessage',
      'ListMessages',
      'ReplyMessage',
      'AgentResult',
      'AgentHealth',
      'WaitForAll',
      'StopAgent',
      'StopAgents',
      'InterruptAgent',
      'DismissAgents',
      'RenameAgent',
      'TagAgent',
    ]);

    for (const name of coder.tools ?? []) {
      if (notWorkerTools.has(name)) {
        continue;
      }
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain('Agent');
    expect(tools).not.toContain('AgentSwarm');
    expect(tools).not.toContain('EnterPlanMode');
    expect(tools).not.toContain('ExitPlanMode');
    expect(tools).not.toContain('EnterSupermoonMode');
    expect(tools).not.toContain('ExitSupermoonMode');
    expect(tools).not.toContain('SendMessage');
    expect(tools).not.toContain('ListAgents');
    expect(tools).not.toContain('NotifyUser');
    for (const name of [
      'TowerComplete',
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

  it('declares no subagent roster and no summary policy', () => {
    expect(TOWER_WORKER_PROFILE_DEF.subagents).toBeUndefined();
    expect(TOWER_WORKER_PROFILE_DEF.summaryPolicy).toBeUndefined();
    expect(TOWER_WORKER_PROFILE_DEF.whenToUse).toBe(builtinProfile('coder').whenToUse);
  });

  it('tells the worker that the final message is the entire handoff', () => {
    const text = TOWER_WORKER_PROFILE_DEF.renderSystemPrompt({ cwd: '/work' }).text;

    expect(text).toContain('Your final message is the entire handoff.');
    expect(text).toContain('what you changed and why, the path of every file you touched');
    expect(text).toContain(
      'If you are stopped before finishing, the parent receives only what you have written so far, so keep the handoff current.',
    );
    expect(text).not.toContain('sent back to you for expansion');
    expect(text).toContain('You are a tower worker/reviewer in a multi-agent tower workspace.');
  });
});
