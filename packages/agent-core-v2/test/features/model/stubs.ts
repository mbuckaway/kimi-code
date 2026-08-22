import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { StaticAuthProvider, type IModelCatalog, type Model, type ModelCatalogItem } from '#/kosong/model/catalog';

export interface StubModelSpec {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly displayName?: string | undefined;
  readonly name?: string | undefined;
}

export function makeModel(spec: StubModelSpec): Model {
  return {
    id: spec.id,
    name: spec.name ?? spec.model,
    aliases: [],
    protocol: 'openai',
    baseUrl: 'https://api.example.test/v1',
    headers: {},
    capabilities: UNKNOWN_CAPABILITY,
    maxContextSize: spec.maxContextSize,
    displayName: spec.displayName,
    alwaysThinking: false,
    providerType: 'openai',
    providerName: spec.provider,
    authProvider: new StaticAuthProvider('test-key'),
  };
}

export function toCatalogItem(spec: StubModelSpec): ModelCatalogItem {
  return {
    provider: spec.provider,
    model: spec.model,
    display_name: spec.displayName ?? spec.model,
    max_context_size: spec.maxContextSize,
  };
}

export function stubModelCatalog(specs: readonly StubModelSpec[]): IModelCatalog {
  const models = new Map(specs.map((spec) => [spec.id, makeModel(spec)]));
  const items = specs.map(toCatalogItem);
  return {
    _serviceBrand: undefined,
    get: (id: string) => {
      const model = models.get(id);
      if (model === undefined) {
        throw new Error(`model ${id} does not exist`);
      }
      return model;
    },
    listModels: async () => [...items],
    getRequester: () => {
      throw new Error('stubModelCatalog.getRequester is not implemented');
    },
    inspect: () => {
      throw new Error('stubModelCatalog.inspect is not implemented');
    },
    ping: () => {
      throw new Error('stubModelCatalog.ping is not implemented');
    },
    findByName: () => [],
    listProviders: async () => [],
    getProvider: () => {
      throw new Error('stubModelCatalog.getProvider is not implemented');
    },
    setDefaultModel: () => {
      throw new Error('stubModelCatalog.setDefaultModel is not implemented');
    },
  };
}
