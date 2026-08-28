import { describe, expect, it, vi } from 'vitest';

import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentSupermoonService,
  ISessionManager,
} from '@moonshot-ai/agent-core-v2';

import { applySessionAgentConfig } from '../src/routes/sessionAgentConfig';

type ApplyAgentConfigCore = Parameters<typeof applySessionAgentConfig>[0];

function accessor(
  entries: ReadonlyArray<readonly [unknown, unknown]>,
): { get<T>(id: T): T } {
  return {
    get<T>(id: T): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

function stubChain(supermoon: {
  isActive: boolean;
  enter: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
}): ApplyAgentConfigCore {
  const agent = {
    id: 'main',
    kind: 'agent',
    accessor: accessor([
      [IAgentProfileService, {}],
      [IAgentSupermoonService, supermoon],
    ]),
    dispose: () => {},
  };
  const session = {
    id: 'session-test',
    kind: 'session',
    accessor: accessor([
      [
        IAgentLifecycleService,
        {
          create: () => Promise.resolve({ agentId: 'main', generation: 1 }),
          handleOf: (agentId: string) => (agentId === 'main' ? agent : undefined),
        },
      ],
    ]),
    dispose: () => {},
  };
  return {
    accessor: accessor([[ISessionManager, { resume: () => Promise.resolve(session) }]]),
  } as unknown as ApplyAgentConfigCore;
}

describe('applySessionAgentConfig supermoon dispatch', () => {
  it('enters supermoon mode from a supermoon_mode: true patch when inactive', async () => {
    const enter = vi.fn();
    const exit = vi.fn();

    await applySessionAgentConfig(stubChain({ isActive: false, enter, exit }), 'session-test', {
      supermoon_mode: true,
    });

    expect(enter).toHaveBeenCalledWith('manual');
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits supermoon mode from a supermoon_mode: false patch when active', async () => {
    const enter = vi.fn();
    const exit = vi.fn();

    await applySessionAgentConfig(stubChain({ isActive: true, enter, exit }), 'session-test', {
      supermoon_mode: false,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(enter).not.toHaveBeenCalled();
  });

  it('leaves supermoon mode untouched when the patch matches the current state', async () => {
    const enter = vi.fn();
    const exit = vi.fn();

    await applySessionAgentConfig(stubChain({ isActive: true, enter, exit }), 'session-test', {
      supermoon_mode: true,
    });

    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
