import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires the tower control tools into the default profile', () => {
    const agent = profile('agent');
    expect(agent.tools).toContain('TowerInit');
    expect(agent.tools).toContain('TowerStatus');
    expect(agent.tools).toContain('TowerTeardown');
  });

  it('caps the default profile delegation at non-spawning profiles', () => {
    const agent = profile('agent');
    expect(agent.subagents).toEqual(['coder', 'explore', 'plan']);
  });

  it.each(['agent', 'coder', 'explore'] as const)(
    'wires the fleet visibility tools into the %s profile',
    (name) => {
      const found = profile(name);
      expect(found.tools).toEqual(
        expect.arrayContaining(['AgentResult', 'AgentHealth', 'WaitForAll', 'ListMessages']),
      );
    },
  );

  it.each(['agent', 'coder'] as const)(
    'wires the reply and broadcast tools into the %s profile',
    (name) => {
      const found = profile(name);
      expect(found.tools).toEqual(
        expect.arrayContaining(['ReplyMessage', 'BroadcastMessage']),
      );
    },
  );

  it('keeps the reply and broadcast tools out of the explore profile', () => {
    const found = profile('explore');
    expect(found.tools).not.toContain('ReplyMessage');
    expect(found.tools).not.toContain('BroadcastMessage');
  });

  it.each(['agent', 'coder'] as const)(
    'wires the fleet control tools into the %s profile',
    (name) => {
      const found = profile(name);
      expect(found.tools).toEqual(
        expect.arrayContaining([
          'StopAgent',
          'InterruptAgent',
          'DismissAgents',
          'TagAgent',
          'RenameAgent',
          'StopAgents',
        ]),
      );
    },
  );

  it('keeps the fleet control tools out of the explore profile', () => {
    const found = profile('explore');
    expect(found.tools).not.toContain('StopAgent');
    expect(found.tools).not.toContain('InterruptAgent');
    expect(found.tools).not.toContain('DismissAgents');
    expect(found.tools).not.toContain('TagAgent');
    expect(found.tools).not.toContain('RenameAgent');
    expect(found.tools).not.toContain('StopAgents');
  });
});
