import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelToolsService } from '#/features/model/model';
import { ModelToolsService } from '#/features/model/modelService';

import { registerLogServices } from '../../_base/log/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { stubModelCatalog, type StubModelSpec } from './stubs';

const SPECS: readonly StubModelSpec[] = [
  { id: 'p1/m1', provider: 'p1', model: 'm1', maxContextSize: 200_000, displayName: 'M1 Model' },
  { id: 'p1/m2', provider: 'p1', model: 'm2', maxContextSize: 128_000 },
  { id: 'p2/m3', provider: 'p2', model: 'm3', maxContextSize: 300_000 },
];

interface SetupResult {
  readonly config: StubConfigService;
  readonly setModel: ReturnType<typeof vi.fn>;
  readonly currentModel: () => string;
}

describe('ModelToolsService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => disposables.dispose());

  function setup(options: {
    readonly config?: Record<string, unknown>;
    readonly specs?: readonly StubModelSpec[];
    readonly currentModel?: string;
  } = {}): SetupResult {
    const config = new StubConfigService(options.config);
    let current = options.currentModel ?? '';
    const setModel = vi.fn(async (model: string) => {
      current = model;
      return { model };
    });
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IConfigService, config);
        reg.defineInstance(IModelCatalog, stubModelCatalog(options.specs ?? SPECS));
        reg.definePartialInstance(IAgentProfileService, {
          getModel: () => current,
          setModel,
        });
        reg.define(IModelToolsService, ModelToolsService);
      },
    });
    return { config, setModel, currentModel: () => current };
  }

  function service(): IModelToolsService {
    return ix.get(IModelToolsService);
  }

  describe('getCurrent', () => {
    it('returns the resolved current model with role current when no pointer matches', async () => {
      setup({ currentModel: 'p1/m1' });
      const result = await service().getCurrent();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({
        id: 'p1/m1',
        provider: 'p1',
        model: 'm1',
        displayName: 'M1 Model',
        maxContextSize: 200_000,
        role: 'current',
      });
    });

    it('marks the current model as default when it matches defaultModel', async () => {
      setup({ config: { defaultModel: 'p1/m1' }, currentModel: 'p1/m1' });
      const result = await service().getCurrent();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.role).toBe('default');
    });

    it('marks the current model as planning when it matches planningModel', async () => {
      setup({
        config: { defaultModel: 'p1/m1', planningModel: 'p1/m1' },
        currentModel: 'p1/m1',
      });
      const result = await service().getCurrent();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.role).toBe('planning');
    });

    it('returns an error when no model is bound to the agent', async () => {
      setup({ currentModel: '' });
      const result = await service().getCurrent();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('No model');
    });

    it('returns an error when the catalog cannot resolve the current model', async () => {
      setup({ currentModel: 'p9/missing' });
      const result = await service().getCurrent();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('p9/missing');
    });
  });

  describe('list', () => {
    it('returns catalog entries with current/default/planning markers', async () => {
      setup({
        config: { defaultModel: 'p1/m2', planningModel: 'p1/m1' },
        currentModel: 'p1/m1',
      });
      const result = await service().list();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        {
          id: 'p1/m1',
          provider: 'p1',
          model: 'm1',
          displayName: 'M1 Model',
          maxContextSize: 200_000,
          isCurrent: true,
          isDefault: false,
          isPlanning: true,
        },
        {
          id: 'p1/m2',
          provider: 'p1',
          model: 'm2',
          displayName: 'm2',
          maxContextSize: 128_000,
          isCurrent: false,
          isDefault: true,
          isPlanning: false,
        },
        {
          id: 'p2/m3',
          provider: 'p2',
          model: 'm3',
          displayName: 'm3',
          maxContextSize: 300_000,
          isCurrent: false,
          isDefault: false,
          isPlanning: false,
        },
      ]);
    });

    it('filters entries by provider', async () => {
      setup({ currentModel: 'p1/m1' });
      const result = await service().list('p1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.every((entry) => entry.provider === 'p1')).toBe(true);
      }
    });

    it('returns an empty list for a provider with no entries', async () => {
      setup({ currentModel: 'p1/m1' });
      const result = await service().list('p3');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual([]);
    });

    it('returns an error when the catalog list fails', async () => {
      setup({
        currentModel: 'p1/m1',
        specs: [
          {
            id: 'p1/m1',
            provider: 'p1',
            model: 'm1',
            maxContextSize: 200_000,
          },
        ],
      });
      ix.stub(IModelCatalog, {
        _serviceBrand: undefined,
        get: () => {
          throw new Error('boom');
        },
        listModels: async () => {
          throw new Error('catalog unavailable');
        },
      } as never);
      const result = await service().list();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('catalog unavailable');
    });
  });

  describe('set current', () => {
    it('switches the current model when the target context window is large enough', async () => {
      const { setModel, currentModel } = setup({ currentModel: 'p1/m1' });
      const result = await service().set('p2/m3', 'current');

      expect(result.ok).toBe(true);
      expect(setModel).toHaveBeenCalledWith('p2/m3');
      expect(currentModel()).toBe('p2/m3');
    });

    it('rejects a target with a smaller context window than the current model', async () => {
      const { setModel, currentModel } = setup({ currentModel: 'p2/m3' });
      const result = await service().set('p1/m2', 'current');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('smaller context window');
      expect(setModel).not.toHaveBeenCalled();
      expect(currentModel()).toBe('p2/m3');
    });

    it('returns an error when the target model is unknown', async () => {
      const result = await service().set('p9/missing', 'current');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('p9/missing');
    });

    it('returns an error when the current model cannot be resolved', async () => {
      setup({ currentModel: '' });
      const result = await service().set('p1/m1', 'current');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('No model');
    });
  });

  describe('set default', () => {
    it('persists the model as the default', async () => {
      const { config } = setup({ currentModel: 'p1/m1' });
      const result = await service().set('p2/m3', 'default');

      expect(result.ok).toBe(true);
      expect(config.get<string>('defaultModel')).toBe('p2/m3');
    });

    it('returns an error when persisting the default model fails', async () => {
      const config = new StubConfigService({});
      const failingSet = vi.fn(async () => {
        throw new Error('persist blocked');
      });
      ix = createServices(disposables, {
        base: [registerLogServices],
        additionalServices: (reg) => {
          reg.defineInstance(IConfigService, Object.assign(config, { set: failingSet }));
          reg.defineInstance(IModelCatalog, stubModelCatalog(SPECS));
          reg.definePartialInstance(IAgentProfileService, {
            getModel: () => 'p1/m1',
            setModel: async () => ({ model: 'p1/m1' }),
          });
          reg.define(IModelToolsService, ModelToolsService);
        },
      });
      const result = await service().set('p1/m2', 'default');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('persist blocked');
    });
  });

  describe('set planning', () => {
    it('sets the planning model when its context window matches the default model', async () => {
      const { config } = setup({
        config: { defaultModel: 'p2/m3' },
        currentModel: 'p1/m1',
      });
      const result = await service().set('p2/m3', 'planning');

      expect(result.ok).toBe(true);
      expect(config.get<string>('planningModel')).toBe('p2/m3');
    });

    it('rejects a planning model whose context window differs from the default model', async () => {
      const { config } = setup({
        config: { defaultModel: 'p2/m3' },
        currentModel: 'p1/m1',
      });
      const result = await service().set('p1/m2', 'planning');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('match');
      expect(config.get<string>('planningModel')).toBeUndefined();
    });

    it('returns an error when the default model cannot be resolved', async () => {
      setup({
        config: { defaultModel: 'p9/missing' },
        currentModel: 'p1/m1',
      });
      const result = await service().set('p1/m1', 'planning');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('p9/missing');
    });

    it('returns an error when persisting the planning model fails', async () => {
      const config = new StubConfigService({ defaultModel: 'p2/m3' });
      const failingSet = vi.fn(async () => {
        throw new Error('persist blocked');
      });
      ix = createServices(disposables, {
        base: [registerLogServices],
        additionalServices: (reg) => {
          reg.defineInstance(IConfigService, Object.assign(config, { set: failingSet }));
          reg.defineInstance(IModelCatalog, stubModelCatalog(SPECS));
          reg.definePartialInstance(IAgentProfileService, {
            getModel: () => 'p1/m1',
            setModel: async () => ({ model: 'p1/m1' }),
          });
          reg.define(IModelToolsService, ModelToolsService);
        },
      });
      const result = await service().set('p2/m3', 'planning');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('persist blocked');
    });
  });
});
