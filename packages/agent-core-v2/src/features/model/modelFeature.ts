import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { ScopeActivation } from '#/_base/di/instantiation';

import { IModelToolsService } from './model';
import { ModelToolsService } from './modelService';
import { IModelQueryTool } from './tools/modelquery/modelquery';
import { ModelQueryTool } from './tools/modelquery/modelQueryTool';
import { IModelListTool } from './tools/modellist/modellist';
import { ModelListTool } from './tools/modellist/modelListTool';
import { IModelSetTool } from './tools/modelset/modelset';
import { ModelSetTool } from './tools/modelset/modelSetTool';

export class ModelFeature extends Feature {
  static override readonly name = 'model';

  constructor() {
    super();
    this.contributeAgentService(IModelToolsService, ModelToolsService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeTool(IModelQueryTool, ModelQueryTool, {
      name: 'modelquery',
      domain: 'model',
    });
    this.contributeTool(IModelListTool, ModelListTool, {
      name: 'modellist',
      domain: 'model',
    });
    this.contributeTool(IModelSetTool, ModelSetTool, {
      name: 'modelset',
      domain: 'model',
    });
  }
}

registerFeature(ModelFeature);
