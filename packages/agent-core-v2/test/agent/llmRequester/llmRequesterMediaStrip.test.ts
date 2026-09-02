import { describe, expect, it } from 'vitest';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { llmRequesterMediaStrippedTurnsKey } from '#/agent/llmRequester/llmRequesterService';
import { MediaStripped } from '#/agent/llmRequester/llmRequestOps';
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
