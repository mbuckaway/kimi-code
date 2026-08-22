/**
 * ModelQuery / ModelList / ModelSet builtin tools and the context-window
 * switch guard, exercised against a real Agent-backed config surface.
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import type { KimiConfig } from '../../src/config';
import { ProviderManager } from '../../src/session/provider-manager';
import { ModelListInputSchema, ModelListTool } from '../../src/tools/builtin/model/model-list';
import { ModelQueryTool } from '../../src/tools/builtin/model/model-query';
import { ModelSetInputSchema, ModelSetTool } from '../../src/tools/builtin/model/model-set';
import { resolveModelInfo } from '../../src/tools/builtin/model/model-info';
import {
  canSwitchModel,
  planningModelMatchesDefault,
} from '../../src/tools/builtin/model/switch-guard';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

const MODEL_CONFIG: KimiConfig = {
  providers: {
    test: { type: 'kimi', apiKey: 'test-key' },
    other: { type: 'kimi', apiKey: 'test-key-2' },
  },
  defaultModel: 'large-model',
  planningModel: 'planning-model',
  models: {
    'large-model': {
      provider: 'test',
      model: 'large-model',
      maxContextSize: 1_000_000,
      displayName: 'Large Context',
    },
    'equal-model': {
      provider: 'test',
      model: 'equal-model',
      maxContextSize: 1_000_000,
      displayName: 'Equal Context',
    },
    'small-model': {
      provider: 'test',
      model: 'small-model',
      maxContextSize: 128_000,
    },
    'planning-model': {
      provider: 'test',
      model: 'planning-model',
      maxContextSize: 256_000,
      displayName: 'Planning Model',
    },
    'other-provider-model': {
      provider: 'other',
      model: 'other-provider-model',
      maxContextSize: 64_000,
      displayName: 'Other Provider',
    },
  },
};

function makeModelAgent(currentAlias: string, config: KimiConfig = MODEL_CONFIG): Agent {
  const ctx = testAgent({ initialConfig: config });
  ctx.agent.config.update({
    modelAlias: currentAlias,
    thinkingEffort: 'off',
    systemPrompt: 'test agent',
  });
  return ctx.agent;
}

describe('context-window switch guard', () => {
  it('allows a target window equal to or larger than the current window', () => {
    expect(canSwitchModel(1_000_000, 128_000)).toBe(true);
    expect(canSwitchModel(128_000, 128_000)).toBe(true);
  });

  it('rejects a target window smaller than the current window', () => {
    expect(canSwitchModel(64_000, 128_000)).toBe(false);
  });

  it('treats unknown (<= 0) windows as not switchable', () => {
    expect(canSwitchModel(0, 128_000)).toBe(false);
    expect(canSwitchModel(128_000, 0)).toBe(false);
    expect(canSwitchModel(0, 0)).toBe(false);
    expect(canSwitchModel(-1, 128_000)).toBe(false);
    expect(canSwitchModel(128_000, -1)).toBe(false);
  });

  it('planningModelMatchesDefault compares strings for equality', () => {
    expect(planningModelMatchesDefault('planning-model', 'planning-model')).toBe(true);
    expect(planningModelMatchesDefault('planning-model', 'default-model')).toBe(false);
    expect(planningModelMatchesDefault(undefined, undefined)).toBe(true);
    expect(planningModelMatchesDefault('planning-model', undefined)).toBe(false);
    expect(planningModelMatchesDefault(undefined, 'default-model')).toBe(false);
  });
});

describe('resolveModelInfo fallback', () => {
  it('returns undefined when the provider resolver throws', () => {
    const agent = {
      kimiConfig: {},
      modelProvider: {
        resolveProviderConfig: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Agent;

    expect(resolveModelInfo(agent, 'x/y')).toBeUndefined();
  });

  it('returns undefined when the provider resolver yields nothing', () => {
    const agent = {
      kimiConfig: {},
      modelProvider: {
        resolveProviderConfig: () => undefined,
      },
    } as unknown as Agent;

    expect(resolveModelInfo(agent, 'x/y')).toBeUndefined();
  });
});

describe('ModelQueryTool', () => {
  it('reports the current model id and resolved details', async () => {
    const agent = makeModelAgent('large-model');

    const result = await executeTool(new ModelQueryTool(agent), {
      turnId: '0',
      toolCallId: 'tc_query',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output as string)).toEqual({
      id: 'large-model',
      provider: 'test',
      model: 'large-model',
      displayName: 'Large Context',
      maxContextSize: 1_000_000,
    });
  });

  it('falls back to resolveProviderConfig when kimiConfig.models is absent', async () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({ config: MODEL_CONFIG }),
    });
    ctx.agent.config.update({
      modelAlias: 'large-model',
      thinkingEffort: 'off',
      systemPrompt: 'test agent',
    });

    const result = await executeTool(new ModelQueryTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_fallback',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: 'large-model',
      provider: 'test',
      model: 'large-model',
      maxContextSize: 1_000_000,
    });
    expect(parsed).not.toHaveProperty('displayName');
  });

  it('returns an error when no model is selected', async () => {
    const ctx = testAgent({ initialConfig: MODEL_CONFIG });

    const result = await executeTool(new ModelQueryTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_none',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No model is currently selected');
  });
});

describe('ModelListTool', () => {
  it('lists every configured model and marks current, default, and planning', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelListTool(agent), {
      turnId: '0',
      toolCallId: 'tc_list',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output as string)).toEqual([
      {
        id: 'large-model',
        provider: 'test',
        model: 'large-model',
        displayName: 'Large Context',
        maxContextSize: 1_000_000,
        current: false,
        default: true,
        planning: false,
      },
      {
        id: 'equal-model',
        provider: 'test',
        model: 'equal-model',
        displayName: 'Equal Context',
        maxContextSize: 1_000_000,
        current: false,
        default: false,
        planning: false,
      },
      {
        id: 'small-model',
        provider: 'test',
        model: 'small-model',
        maxContextSize: 128_000,
        current: true,
        default: false,
        planning: false,
      },
      {
        id: 'planning-model',
        provider: 'test',
        model: 'planning-model',
        displayName: 'Planning Model',
        maxContextSize: 256_000,
        current: false,
        default: false,
        planning: true,
      },
      {
        id: 'other-provider-model',
        provider: 'other',
        model: 'other-provider-model',
        displayName: 'Other Provider',
        maxContextSize: 64_000,
        current: false,
        default: false,
        planning: false,
      },
    ]);
  });

  it('filters the list by provider', async () => {
    const agent = makeModelAgent('large-model');

    const result = await executeTool(new ModelListTool(agent), {
      turnId: '0',
      toolCallId: 'tc_filter',
      args: { provider: 'test' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    const list = JSON.parse(result.output as string) as ReadonlyArray<{ readonly id: string }>;
    expect(list.map((entry) => entry.id)).toEqual([
      'large-model',
      'equal-model',
      'small-model',
      'planning-model',
    ]);
  });

  it('returns an error when no models are configured', async () => {
    const ctx = testAgent({ initialConfig: { providers: {} } });

    const result = await executeTool(new ModelListTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_empty',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No models are configured');
  });

  it('validates the input schema', () => {
    expect(ModelListInputSchema.safeParse({}).success).toBe(true);
    expect(ModelListInputSchema.safeParse({ provider: 'test' }).success).toBe(true);
    expect(ModelListInputSchema.safeParse({ provider: '' }).success).toBe(true);
    expect(ModelListInputSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
});

describe('ModelSetTool', () => {
  it('switches the current model when the target window fits', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_switch',
      args: { model: 'large-model' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Switched the current model to "large-model"');
    expect(agent.config.modelAlias).toBe('large-model');
  });

  it('accepts an explicit current role', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_role_current',
      args: { model: 'large-model', role: 'current' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(agent.config.modelAlias).toBe('large-model');
  });

  it('allows a switch to a model with an equal context window', async () => {
    const agent = makeModelAgent('large-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_equal',
      args: { model: 'equal-model' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(agent.config.modelAlias).toBe('equal-model');
  });

  it('rejects an unknown model without throwing', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_unknown',
      args: { model: 'nope-model' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('nope-model');
    expect(agent.config.modelAlias).toBe('small-model');
  });

  it('rejects a model with a smaller context window, naming both windows', async () => {
    const agent = makeModelAgent('large-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_small',
      args: { model: 'small-model' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('1000000');
    expect(result.output).toContain('128000');
    expect(agent.config.modelAlias).toBe('large-model');
  });

  it('rejects a switch when the current model window is unknown', async () => {
    const ctx = testAgent({ initialConfig: MODEL_CONFIG });

    const result = await executeTool(new ModelSetTool(ctx.agent), {
      turnId: '0',
      toolCallId: 'tc_unknown_current',
      args: { model: 'large-model' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Cannot switch to model "large-model"');
    expect(ctx.agent.config.modelAlias).toBeUndefined();
  });

  it('rejects persisting the default model in the legacy engine', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_default',
      args: { model: 'large-model', role: 'default' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain(
      'Persisting the default/planning model is not supported in the legacy engine',
    );
    expect(agent.config.modelAlias).toBe('small-model');
  });

  it('rejects persisting the planning model in the legacy engine', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_planning',
      args: { model: 'large-model', role: 'planning' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain(
      'Persisting the default/planning model is not supported in the legacy engine',
    );
    expect(agent.config.modelAlias).toBe('small-model');
  });

  it('rejects an empty model argument', async () => {
    const agent = makeModelAgent('small-model');

    const result = await executeTool(new ModelSetTool(agent), {
      turnId: '0',
      toolCallId: 'tc_empty_model',
      args: { model: '' },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(agent.config.modelAlias).toBe('small-model');
  });

  it('validates the input schema', () => {
    expect(ModelSetInputSchema.safeParse({ model: 'x' }).success).toBe(true);
    expect(ModelSetInputSchema.safeParse({ model: 'x', role: 'current' }).success).toBe(true);
    expect(ModelSetInputSchema.safeParse({ model: 'x', role: 'default' }).success).toBe(true);
    expect(ModelSetInputSchema.safeParse({ model: 'x', role: 'planning' }).success).toBe(true);
    expect(ModelSetInputSchema.safeParse({}).success).toBe(false);
    expect(ModelSetInputSchema.safeParse({ model: 'x', role: 'bogus' }).success).toBe(false);
  });
});
