import { beforeEach, describe, expect, it } from 'vitest';

import type { CollectionToken, CollectionView } from '#/_base/di/collection';
import { ScopeActivation } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { IModelToolsService } from '#/features/model/model';
import { ModelFeature } from '#/features/model/modelFeature';
import { ModelQueryTool } from '#/features/model/tools/modelquery/modelQueryTool';
import { ModelListTool } from '#/features/model/tools/modellist/modelListTool';
import { ModelSetTool } from '#/features/model/tools/modelset/modelSetTool';

import { stubLog } from '../../_base/log/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { stubModelCatalog, type StubModelSpec } from './stubs';

const SPECS: readonly StubModelSpec[] = [
  { id: 'p1/m1', provider: 'p1', model: 'm1', maxContextSize: 200_000 },
];

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('ModelFeature', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
    registerFeature(ModelFeature);
  });

  it('assembles a named, introspectable model unit', () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toContain('model');
    host.dispose();
  });

  it('resolves and retracts IModelToolsService in the Agent scope with the Feature', async () => {
    const host = createScopedTestHost();
    const agent = host.child(LifecycleScope.Agent, 'agent-1', [
      stubPair(IAgentProfileService, {} as IAgentProfileService),
      stubPair(IModelCatalog, stubModelCatalog(SPECS)),
      stubPair(IConfigService, new StubConfigService({})),
      stubPair(ILogService, stubLog()),
    ]);
    const manager = host.app.accessor.get(IFeatureManager);

    expect(agent.accessor.get(IModelToolsService)).toBeDefined();

    await manager.unprovideUnit('model');
    await host.app.instantiation.cascade.whenIdle();
    expect(() => agent.accessor.get(IModelToolsService)).toThrow();

    manager.provideUnit(ModelFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(agent.accessor.get(IModelToolsService)).toBeDefined();

    host.dispose();
  });

  it.each([
    ['ModelQueryTool', ModelQueryTool, 'modelquery'],
    ['ModelListTool', ModelListTool, 'modellist'],
    ['ModelSetTool', ModelSetTool, 'modelset'],
  ] as const)(
    '%s is contributed to the Agent scope under the %s name',
    (_name, ctor, toolName) => {
      const host = createScopedTestHost();
      const agent = host.child(LifecycleScope.Agent, 'agent-1', [
        stubPair(IAgentProfileService, {} as IAgentProfileService),
        stubPair(IModelCatalog, stubModelCatalog(SPECS)),
        stubPair(IConfigService, new StubConfigService({})),
        stubPair(ILogService, stubLog()),
      ]);
      const contribution = collectionViewOf(agent, AgentToolContribution).items.find(
        (c) => c.ctor === ctor,
      );
      expect(contribution, `${_name} contribution`).toBeDefined();
      expect(contribution?.options.name).toBe(toolName);
      expect(contribution?.options.domain).toBe('model');
      host.dispose();
    },
  );
});
