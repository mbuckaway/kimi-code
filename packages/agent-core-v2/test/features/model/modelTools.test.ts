import { describe, expect, it, vi } from 'vitest';

import type { IModelToolsService } from '#/features/model/model';
import { ModelQueryTool } from '#/features/model/tools/modelquery/modelQueryTool';
import { ModelListTool } from '#/features/model/tools/modellist/modelListTool';
import { ModelSetTool } from '#/features/model/tools/modelset/modelSetTool';
import { ModelSetInputSchema } from '#/features/model/tools/modelset/modelset';
import { ModelListInputSchema } from '#/features/model/tools/modellist/modellist';

import { executeTool } from '../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function stubModelTools(overrides: Partial<IModelToolsService>): IModelToolsService {
  return {
    _serviceBrand: undefined,
    getCurrent: async () => ({
      ok: true,
      data: {
        id: 'p1/m1',
        provider: 'p1',
        model: 'm1',
        displayName: 'M1 Model',
        maxContextSize: 200_000,
        role: 'current',
      },
    }),
    list: async () => ({
      ok: true,
      data: [
        {
          id: 'p1/m1',
          provider: 'p1',
          model: 'm1',
          displayName: 'M1 Model',
          maxContextSize: 200_000,
          isCurrent: true,
          isDefault: true,
          isPlanning: false,
        },
      ],
    }),
    set: async () => ({ ok: true }),
    ...overrides,
  } as IModelToolsService;
}

function toolContext(args: Record<string, unknown>, toolCallId = 'call_model'): Parameters<typeof executeTool>[1] {
  return { turnId: 0, toolCallId, args, signal };
}

describe('modelquery tool', () => {
  it('reports the current model details', async () => {
    const tool = new ModelQueryTool(stubModelTools({}));
    const result = await executeTool(tool, toolContext({}));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('p1/m1');
    expect(result.output).toContain('current');
    expect(result.output).toContain('200000');
  });

  it('reports the model query error when no model is bound', async () => {
    const tool = new ModelQueryTool(
      stubModelTools({ getCurrent: async () => ({ ok: false, error: 'No model is bound.' }) }),
    );
    const result = await executeTool(tool, toolContext({}));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('No model is bound.');
  });
});

describe('modellist tool', () => {
  it('lists models with their markers', async () => {
    const tool = new ModelListTool(stubModelTools({}));
    const result = await executeTool(tool, toolContext({}));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('p1/m1');
    expect(result.output).toContain('current, default');
  });

  it('passes the provider filter to the service', async () => {
    const list = vi.fn(async () => ({ ok: true, data: [] as never[] }));
    const tool = new ModelListTool(stubModelTools({ list: list as never }));
    await executeTool(tool, toolContext({ provider: 'p1' }));

    expect(list).toHaveBeenCalledWith('p1');
  });

  it('reports an empty catalog', async () => {
    const tool = new ModelListTool(stubModelTools({ list: async () => ({ ok: true, data: [] }) }));
    const result = await executeTool(tool, toolContext({}));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No models');
  });

  it('reports the listing error', async () => {
    const tool = new ModelListTool(
      stubModelTools({ list: async () => ({ ok: false, error: 'catalog unavailable' }) }),
    );
    const result = await executeTool(tool, toolContext({}));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('catalog unavailable');
  });
});

describe('modelset tool', () => {
  it('defaults the role to current', async () => {
    const set = vi.fn(async () => ({ ok: true }));
    const tool = new ModelSetTool(stubModelTools({ set: set as never }));
    const result = await executeTool(tool, toolContext({ model: 'p1/m1' }));

    expect(result.isError).toBeFalsy();
    expect(set).toHaveBeenCalledWith('p1/m1', 'current');
  });

  it.each(['default', 'planning'] as const)('passes the %s role through', async (role) => {
    const set = vi.fn(async () => ({ ok: true }));
    const tool = new ModelSetTool(stubModelTools({ set: set as never }));
    await executeTool(tool, toolContext({ model: 'p1/m1', role }));

    expect(set).toHaveBeenCalledWith('p1/m1', role);
  });

  it('reports a guard failure as a tool error', async () => {
    const tool = new ModelSetTool(
      stubModelTools({
        set: async () => ({
          ok: false,
          error: 'target model p1/m2 has a smaller context window than the current model',
        }),
      }),
    );
    const result = await executeTool(tool, toolContext({ model: 'p1/m2' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('smaller context window');
  });

  it('rejects an unknown role', () => {
    expect(ModelSetInputSchema.safeParse({ model: 'p1/m1', role: 'primary' }).success).toBe(false);
  });

  it('rejects a missing model', () => {
    expect(ModelSetInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a blank provider filter', () => {
    expect(ModelListInputSchema.safeParse({ provider: '  ' }).success).toBe(false);
  });
});
