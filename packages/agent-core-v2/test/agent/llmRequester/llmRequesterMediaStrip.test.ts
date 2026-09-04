import { describe, expect, it } from 'vitest';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  llmRequesterMediaStrippedTurnsKey,
  llmRequesterThinkingStrippedKey,
} from '#/agent/llmRequester/llmRequesterService';
import { MediaStripped, ThinkingStripped } from '#/agent/llmRequester/llmRequestOps';
import { testAgent } from '../../harness';

describe('llmRequester media-strip durability', () => {
  it('reconstructs the stripped-media key set from a persisted MediaStripped event', async () => {
    const ctx = testAgent({ autoConfigure: false });
    const agentId = ctx.get(IAgentScopeContext).agentId;
    try {
      await ctx.dispatcher.dispatch(
        new MediaStripped({ agentId, keys: ['media-key-a', 'media-key-b'] }),
      );
      await ctx.restorePersisted();
      expect(ctx.agentState.get(llmRequesterMediaStrippedTurnsKey)).toEqual([
        'media-key-a',
        'media-key-b',
      ]);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('llmRequester thinking-strip durability', () => {
  it('leaves the stripped-thinking flag false when no ThinkingStripped event was persisted', async () => {
    const ctx = testAgent({ autoConfigure: false });
    try {
      await ctx.restorePersisted();
      expect(ctx.agentState.get(llmRequesterThinkingStrippedKey)).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });

  it('reconstructs the stripped-thinking flag from a persisted ThinkingStripped event', async () => {
    const ctx = testAgent({ autoConfigure: false });
    const agentId = ctx.get(IAgentScopeContext).agentId;
    try {
      await ctx.dispatcher.dispatch(new ThinkingStripped({ agentId }));
      await ctx.restorePersisted();
      expect(ctx.agentState.get(llmRequesterThinkingStrippedKey)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
