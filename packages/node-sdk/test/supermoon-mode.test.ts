import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';

import { SDKRpcClientBase } from '#/rpc';
import type {
  SetSessionSupermoonModeRpcInput,
  SupermoonModeTrigger,
} from '#/rpc';

/**
 * Test double for `SDKRpcClientBase` whose `getRpc()` returns a stub exposing
 * the supermoon dispatch methods (`enterSupermoon` / `exitSupermoon` /
 * `getSupermoonMode`) plus the prompt sink the base class composes over. The
 * engine's `CoreAPI` now declares the supermoon methods, so the stub can cast
 * straight to the full `RPCMethods<CoreAPI>` shape.
 */
class FakeRpcClient extends SDKRpcClientBase {
  readonly rpcEnterSupermoon = vi.fn();
  readonly rpcExitSupermoon = vi.fn();
  readonly rpcGetSupermoonMode = vi.fn().mockResolvedValue(false);
  readonly rpcPrompt = vi.fn();

  protected getRpc(): Promise<RPCMethods<CoreAPI>> {
    return Promise.resolve({
      enterSupermoon: this.rpcEnterSupermoon,
      exitSupermoon: this.rpcExitSupermoon,
      getSupermoonMode: this.rpcGetSupermoonMode,
      getConfig: vi.fn().mockResolvedValue({
        modelAlias: 'kimi-k2',
        thinkingEffort: 'auto',
        modelCapabilities: { max_context_tokens: 100 },
      }),
      getContext: vi.fn().mockResolvedValue({ history: [], tokenCount: 0 }),
      getPermission: vi.fn().mockResolvedValue({ mode: 'manual' }),
      getPlan: vi.fn().mockResolvedValue(null),
      getSwarmMode: vi.fn().mockResolvedValue(false),
      getUsage: vi.fn().mockResolvedValue({}),
      prompt: this.rpcPrompt,
    } as unknown as RPCMethods<CoreAPI>);
  }
}

describe('Supermoon mode (SDKRpcClientBase)', () => {
  let client: FakeRpcClient;

  beforeEach(() => {
    client = new FakeRpcClient();
  });

  it('setSupermoonMode_enabled_callsEnterSupermoonWithTheManualTrigger', async () => {
    await client.setSupermoonMode({ sessionId: 'session-1', enabled: true, trigger: 'manual' });

    expect(client.rpcEnterSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcEnterSupermoon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
      trigger: 'manual',
    });
    expect(client.rpcExitSupermoon).not.toHaveBeenCalled();
  });

  it('setSupermoonMode_enabled_callsEnterSupermoonWithTheTaskTrigger', async () => {
    await client.setSupermoonMode({ sessionId: 'session-1', enabled: true, trigger: 'task' });

    expect(client.rpcEnterSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcEnterSupermoon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
      trigger: 'task',
    });
  });

  it('setSupermoonMode_disabled_callsExitSupermoonWithoutEntering', async () => {
    await client.setSupermoonMode({ sessionId: 'session-1', enabled: false });

    expect(client.rpcExitSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcExitSupermoon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
    });
    expect(client.rpcEnterSupermoon).not.toHaveBeenCalled();
  });

  it('setSupermoonMode_forwardsTheInteractiveAgentId', async () => {
    await client.withInteractiveAgent('agent-42', () =>
      client.setSupermoonMode({ sessionId: 'session-1', enabled: true, trigger: 'task' }),
    );

    expect(client.rpcEnterSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcEnterSupermoon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'agent-42',
      trigger: 'task',
    });
  });

  it('supermoon_entersTaskTriggeredModeThenPromptsTheInput', async () => {
    const input = [{ type: 'text', text: 'analyze the whole codebase' }] as const;
    await client.supermoon({ sessionId: 'session-1', input });

    expect(client.rpcEnterSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcEnterSupermoon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
      trigger: 'task',
    });
    expect(client.rpcPrompt).toHaveBeenCalledTimes(1);
    expect(client.rpcPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
      input,
    });
    // One-shot semantics: the enter dispatch strictly precedes the prompt.
    expect(client.rpcEnterSupermoon.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
      client.rpcPrompt.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('supermoon_acceptsTheToolTrigger', () => {
    // `tool` is a real trigger now (entered via the EnterSupermoonMode tool;
    // persists like `manual` until ExitSupermoonMode).
    const tool: SupermoonModeTrigger = 'tool';
    expect(tool).toBe('tool');
    expect(client.rpcEnterSupermoon).not.toHaveBeenCalled();
  });

  it('setSupermoonMode_acceptsOnlyTriggeredEnableAndUntriggeredDisable', async () => {
    const enabled: SetSessionSupermoonModeRpcInput = {
      sessionId: 'session-1',
      enabled: true,
      trigger: 'task',
    };
    const disabled: SetSessionSupermoonModeRpcInput = {
      sessionId: 'session-1',
      enabled: false,
    };
    await client.setSupermoonMode(enabled);
    await client.setSupermoonMode(disabled);

    expect(client.rpcEnterSupermoon).toHaveBeenCalledTimes(1);
    expect(client.rpcExitSupermoon).toHaveBeenCalledTimes(1);
  });

  it('getStatus_reportsTheSupermoonModeFromTheEngineRpc', async () => {
    client.rpcGetSupermoonMode.mockResolvedValue(true);

    const status = await client.getStatus({ sessionId: 'session-1' });

    expect(client.rpcGetSupermoonMode).toHaveBeenCalledTimes(1);
    expect(client.rpcGetSupermoonMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'main',
    });
    expect(status.supermoonMode).toBe(true);
  });
});
