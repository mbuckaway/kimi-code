import { ILogService } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_MODEL_SECTION, PLANNING_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalog, type Model, type ModelCatalogItem } from '#/kosong/model/catalog';

import {
  IModelToolsService,
  type CurrentModelInfo,
  type ModelListEntry,
  type ModelRole,
  type ModelServiceResult,
  type ModelSetResult,
} from './model';
import { canSwitchModel, planningModelMatchesDefault } from './switchGuard';

export class ModelToolsService implements IModelToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {}

  async getCurrent(): Promise<ModelServiceResult<CurrentModelInfo>> {
    const id = this.profile.getModel();
    if (id.length === 0) {
      return { ok: false, error: 'No model is bound to the current agent.' };
    }
    let model: Model;
    try {
      model = this.modelCatalog.get(id);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    return {
      ok: true,
      data: {
        id,
        provider: model.providerName,
        model: model.name,
        displayName: model.displayName,
        maxContextSize: model.maxContextSize,
        role: this.roleFor(id),
      },
    };
  }

  async list(provider?: string): Promise<ModelServiceResult<readonly ModelListEntry[]>> {
    let items: readonly ModelCatalogItem[];
    try {
      items = await this.modelCatalog.listModels();
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    const current = this.profile.getModel();
    const defaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    const planningModel = this.config.get<string>(PLANNING_MODEL_SECTION);
    return {
      ok: true,
      data: items
        .filter((item) => provider === undefined || item.provider === provider)
        .map((item) => {
          const id = `${item.provider}/${item.model}`;
          return {
            id,
            provider: item.provider,
            model: item.model,
            displayName: item.display_name,
            maxContextSize: item.max_context_size,
            isCurrent: id === current,
            isDefault: id === defaultModel,
            isPlanning: id === planningModel,
          };
        }),
    };
  }

  async set(model: string, role: ModelRole): Promise<ModelSetResult> {
    let target: Model;
    try {
      target = this.modelCatalog.get(model);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    const result =
      role === 'current'
        ? await this.setCurrent(model, target)
        : role === 'default'
          ? await this.setDefault(model)
          : await this.setPlanning(model, target);
    if (result.ok) {
      this.log.debug('model role set', { model, role });
    }
    return result;
  }

  private roleFor(id: string): CurrentModelInfo['role'] {
    if (id === this.config.get<string>(PLANNING_MODEL_SECTION)) return 'planning';
    if (id === this.config.get<string>(DEFAULT_MODEL_SECTION)) return 'default';
    return 'current';
  }

  private async setCurrent(model: string, target: Model): Promise<ModelSetResult> {
    const currentId = this.profile.getModel();
    if (currentId.length === 0) {
      return { ok: false, error: 'No model is bound to the current agent; cannot switch.' };
    }
    let current: Model;
    try {
      current = this.modelCatalog.get(currentId);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    if (!canSwitchModel(target.maxContextSize, current.maxContextSize)) {
      return {
        ok: false,
        error: `target model ${model} has a smaller context window (${target.maxContextSize}) than the current model ${currentId} (${current.maxContextSize})`,
      };
    }
    try {
      await this.profile.setModel(model);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    return { ok: true };
  }

  private async setDefault(model: string): Promise<ModelSetResult> {
    try {
      await this.config.set(DEFAULT_MODEL_SECTION, model);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    return { ok: true };
  }

  private async setPlanning(model: string, target: Model): Promise<ModelSetResult> {
    const defaultId = this.config.get<string>(DEFAULT_MODEL_SECTION) ?? this.profile.getModel();
    let defaultModel: Model;
    try {
      defaultModel = this.modelCatalog.get(defaultId);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    if (!planningModelMatchesDefault(target.maxContextSize, defaultModel.maxContextSize)) {
      return {
        ok: false,
        error: `planning model ${model} must match the default model ${defaultId} context window (${target.maxContextSize} vs ${defaultModel.maxContextSize})`,
      };
    }
    try {
      await this.config.set(PLANNING_MODEL_SECTION, model);
    } catch (error) {
      return { ok: false, error: describeModelError(error) };
    }
    return { ok: true };
  }
}

function describeModelError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
