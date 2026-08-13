import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';

import { SDKRpcClientBase } from '#/rpc';
import type {
  SetSessionSupermoonModeRpcInput,
  SupermoonModeTrigger,
} from '#/rpc';

/**
 * Test double for `SDKRpcClientBase` whose `getRpc()` returns a stub exposing
 * the supermoon dispatch methods (`enterSupermoon` / `exitSupermoon`) plus the
 * prompt sink the base class composes over. The engine's `CoreAPI` does not
 * declare the supermoon methods yet, so the stub casts itself to the full
 * `RPCMethods<CoreAPI>` shape.
 */
class FakeRpcClient extends SDKRpcClientBase {
  readonly rpcEnterSupermoon = vi.fn();
  readonly rpcExitSupermoon = vi.fn();
  readonly rpcPrompt = vi.fn();

  protected getRpc(): Promise<RPCMethods<CoreAPI>> {
    return Promise.resolve({
      enterSupermoon: this.rpcEnterSupermoon,
      exitSupermoon: this.rpcExitSupermoon,
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

  it('supermoon_rejectsAnUnknownTriggerAtCompileTime', () => {
    // SupermoonModeTrigger deliberately has no `tool` trigger (unlike
    // SwarmModeTrigger) — the discriminated input type below is the spec:
    // enabled requires a manual/task trigger, disabled requires none.
    const manual: SupermoonModeTrigger = 'manual';
    const task: SupermoonModeTrigger = 'task';
    expect(manual).toBe('manual');
    expect(task).toBe('task');

    // @ts-expect-error — SupermoonModeTrigger excludes the 'tool' trigger.
    const tool: SupermoonModeTrigger = 'tool';
    void tool;
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
});
