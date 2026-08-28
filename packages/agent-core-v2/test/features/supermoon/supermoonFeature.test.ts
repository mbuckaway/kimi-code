import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSupermoonService } from '#/agent/supermoon/supermoon';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { type Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { ToolCall } from '#/kosong/contract/message';
import type { ToolResult } from '#/tool/toolContract';

import { createTestAgent, type TestAgentContext } from '../../harness';

async function runTool(ctx: TestAgentContext, name: string, id: string): Promise<ToolResult> {
  const call: ToolCall = { type: 'function', id, name, arguments: '{}' };
  const results: ToolResult[] = [];
  for await (const item of ctx.get(IAgentToolExecutorService).execute([call], {
    turnId: 1,
    signal: new AbortController().signal,
  })) {
    results.push(item.result);
  }
  if (results.length !== 1) {
    throw new Error(`expected one tool result, got ${results.length}`);
  }
  return results[0]!;
}

describe('SupermoonFeature tools in the agent tool registry', () => {
  for (const profileName of ['agent', 'coder'] as const) {
    it(`lists EnterSupermoonMode and ExitSupermoonMode as active tools for the ${profileName} profile`, async () => {
      const ctx = createTestAgent();
      try {
        const profile = ctx.get(IAgentProfileService);
        await profile.bind({ profile: profileName, model: 'mock-model' });

        const activeNames = ctx
          .toolsData()
          .filter((tool) => tool.active)
          .map((tool) => tool.name);
        expect(activeNames).toEqual(
          expect.arrayContaining(['EnterSupermoonMode', 'ExitSupermoonMode']),
        );
      } finally {
        await ctx.dispose();
      }
    });
  }
});

describe('Supermoon mode tools', () => {
  it('EnterSupermoonMode dispatches supermoon_mode.enter with trigger tool and appends the enter reminder', async () => {
    const ctx = createTestAgent();
    try {
      const events: Event2[] = [];
      ctx.get(IEventBus).subscribe((event) => events.push(event));

      const result = await runTool(ctx, 'EnterSupermoonMode', 'call_enter_supermoon');

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain('ExitSupermoonMode');
      expect(ctx.get(IAgentSupermoonService).isActive).toBe(true);
      expect(ctx.allEvents).toContainEqual({
        type: '[wire]',
        event: 'supermoon_mode.enter',
        args: { agentId: 'main', trigger: 'tool', time: expect.any(Number) },
      });
      expect(events).toContainEqual({
        type: 'agent.status.updated',
        agentId: 'main',
        supermoonMode: true,
        time: expect.any(Number),
      });

      const history = ctx.get(IAgentContextMemoryService).get();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        origin: { kind: 'injection', variant: 'supermoon_mode' },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('EnterSupermoonMode returns an error when supermoon mode is already active', async () => {
    const ctx = createTestAgent();
    try {
      ctx.get(IAgentSupermoonService).enter('tool');
      const result = await runTool(ctx, 'EnterSupermoonMode', 'call_enter_supermoon_again');

      expect(result.isError).toBe(true);
      expect(result.output).toBe(
        'Supermoon mode is already active. Use ExitSupermoonMode when you want to leave it.',
      );
      expect(ctx.get(IAgentSupermoonService).isActive).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  it('ExitSupermoonMode dispatches supermoon_mode.exit, emits the status event, and pops the enter reminder', async () => {
    const ctx = createTestAgent();
    try {
      const events: Event2[] = [];
      ctx.get(IEventBus).subscribe((event) => events.push(event));

      await runTool(ctx, 'EnterSupermoonMode', 'call_enter_supermoon');
      const result = await runTool(ctx, 'ExitSupermoonMode', 'call_exit_supermoon');

      expect(result.isError).toBeFalsy();
      expect(ctx.get(IAgentSupermoonService).isActive).toBe(false);
      expect(ctx.allEvents).toContainEqual({
        type: '[wire]',
        event: 'supermoon_mode.exit',
        args: { agentId: 'main', time: expect.any(Number) },
      });
      expect(events).toContainEqual({
        type: 'agent.status.updated',
        agentId: 'main',
        supermoonMode: false,
        time: expect.any(Number),
      });

      const history = ctx.get(IAgentContextMemoryService).get();
      expect(
        history.filter(
          (message) =>
            message.origin?.kind === 'injection' && message.origin.variant === 'supermoon_mode',
        ),
      ).toHaveLength(0);
    } finally {
      await ctx.dispose();
    }
  });

  it('ExitSupermoonMode returns an error when supermoon mode is inactive', async () => {
    const ctx = createTestAgent();
    try {
      const result = await runTool(ctx, 'ExitSupermoonMode', 'call_exit_supermoon');

      expect(result.isError).toBe(true);
      expect(result.output).toBe('Supermoon mode is not active.');
    } finally {
      await ctx.dispose();
    }
  });
});
