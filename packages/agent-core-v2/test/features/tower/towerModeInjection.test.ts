import { describe, expect, it } from 'vitest';

import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { IFlagService } from '#/app/flag/flag';
import type { ContextInjectionProvider } from '#/features/reminder/types';
import { TowerModeInjection } from '#/features/tower/injection/towerModeInjection';
import type { IAgentTowerService } from '#/features/tower/tower';
import { stubFlag } from '../../app/flag/stubs';
import { createReminderStub } from '../reminder/stubs';

import TOWER_MODE_EXIT_REMINDER from '../../../src/features/tower/injection/tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from '../../../src/features/tower/injection/tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from '../../../src/features/tower/injection/tower-mode-sparse-reminder.md?raw';

function assistantMessage(): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'working' }], toolCalls: [] };
}

function userMessage(origin?: PromptOrigin): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'prompt' }],
    toolCalls: [],
    origin: origin ?? { kind: 'user' },
  };
}

function injectionMessage(): ContextMessage {
  return userMessage({ kind: 'injection', variant: 'tower_mode' });
}

interface InjectionRunInput {
  readonly injectedPositions: readonly number[];
  readonly lastInjectedAt: number | null;
  readonly lastDisclosure?: unknown;
}

interface InjectionHarness {
  readonly variant: string;
  readonly run: (input: InjectionRunInput) => Promise<string | undefined>;
  readonly dispose: () => void;
}

function createInjection(options: {
  readonly isActive: boolean;
  readonly flagEnabled?: boolean;
  readonly history?: readonly ContextMessage[];
}): InjectionHarness {
  let provider: ContextInjectionProvider | undefined;
  let registeredVariant = '';
  const reminder = createReminderStub({
    register: (variant, value) => {
      registeredVariant = variant;
      provider = value as ContextInjectionProvider;
      return toDisposable(() => {
        provider = undefined;
      });
    },
  });
  const tower = { isActive: options.isActive } as unknown as IAgentTowerService;
  const context = {
    get: () => options.history ?? [],
  } as unknown as IAgentContextMemoryService;
  const flags = stubFlag(options.flagEnabled ?? true) as IFlagService;
  const injection = new TowerModeInjection(reminder, tower, context, flags);
  return {
    get variant() {
      return registeredVariant;
    },
    run: async (input) => {
      if (provider === undefined) throw new Error('injection provider is not registered');
      const result = await provider({ isNewTurn: true, ...input });
      if (result === undefined) return undefined;
      if (typeof result === 'string') return result;
      if (Array.isArray(result)) return undefined;
      if (!('content' in result)) return undefined;
      return typeof result.content === 'string' ? result.content : undefined;
    },
    dispose: () => injection.dispose(),
  };
}

describe('TowerModeInjection', () => {
  it('registers under the tower_mode variant', () => {
    expect(createInjection({ isActive: false }).variant).toBe('tower_mode');
  });

  it('injects nothing when tower mode was never active', async () => {
    const injection = createInjection({ isActive: false });

    expect(await injection.run({ injectedPositions: [], lastInjectedAt: null })).toBeUndefined();
  });

  it('injects the exit reminder after tower mode ends', async () => {
    const injection = createInjection({
      isActive: false,
      history: [userMessage(), injectionMessage()],
    });

    expect(await injection.run({ injectedPositions: [1], lastInjectedAt: 1 })).toBe(
      TOWER_MODE_EXIT_REMINDER,
    );
  });

  it('does not repeat the exit reminder once it was disclosed', async () => {
    const injection = createInjection({
      isActive: false,
      history: [userMessage(), injectionMessage()],
    });

    expect(
      await injection.run({ injectedPositions: [1], lastInjectedAt: 1, lastDisclosure: 'exit' }),
    ).toBeUndefined();
  });

  it('injects nothing while the tower flag is disabled', async () => {
    const injection = createInjection({ isActive: true, flagEnabled: false });

    expect(await injection.run({ injectedPositions: [], lastInjectedAt: null })).toBeUndefined();
  });

  it('injects the full reminder on the first active turn', async () => {
    const injection = createInjection({ isActive: true, history: [userMessage()] });

    expect(await injection.run({ injectedPositions: [], lastInjectedAt: null })).toBe(
      TOWER_MODE_FULL_REMINDER,
    );
  });

  it('injects the full reminder when the last disclosure was the exit reminder', async () => {
    const injection = createInjection({ isActive: true, history: [injectionMessage()] });

    expect(
      await injection.run({ injectedPositions: [0], lastInjectedAt: 0, lastDisclosure: 'exit' }),
    ).toBe(TOWER_MODE_FULL_REMINDER);
  });

  it('injects the sparse reminder after two assistant turns with no real user prompt', async () => {
    const injection = createInjection({
      isActive: true,
      history: [injectionMessage(), assistantMessage(), assistantMessage()],
    });

    expect(await injection.run({ injectedPositions: [0], lastInjectedAt: 0 })).toBe(
      TOWER_MODE_SPARSE_REMINDER,
    );
  });

  it('injects nothing after a single assistant turn', async () => {
    const injection = createInjection({
      isActive: true,
      history: [injectionMessage(), assistantMessage()],
    });

    expect(await injection.run({ injectedPositions: [0], lastInjectedAt: 0 })).toBeUndefined();
  });

  it('injects the full reminder when a real user prompt follows an assistant turn', async () => {
    const injection = createInjection({
      isActive: true,
      history: [injectionMessage(), assistantMessage(), userMessage()],
    });

    expect(await injection.run({ injectedPositions: [0], lastInjectedAt: 0 })).toBe(
      TOWER_MODE_FULL_REMINDER,
    );
  });

  it('keeps the sparse reminder when the only user message after an assistant turn is an injected one', async () => {
    const injection = createInjection({
      isActive: true,
      history: [
        injectionMessage(),
        assistantMessage(),
        injectionMessage(),
        assistantMessage(),
      ],
    });

    expect(await injection.run({ injectedPositions: [0], lastInjectedAt: 0 })).toBe(
      TOWER_MODE_SPARSE_REMINDER,
    );
  });

  it('refreshes the full reminder after five assistant turns', async () => {
    const injection = createInjection({
      isActive: true,
      history: [
        injectionMessage(),
        assistantMessage(),
        assistantMessage(),
        assistantMessage(),
        assistantMessage(),
        assistantMessage(),
      ],
    });

    expect(await injection.run({ injectedPositions: [0], lastInjectedAt: 0 })).toBe(
      TOWER_MODE_FULL_REMINDER,
    );
  });
});
