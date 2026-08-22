import { createDecorator } from '#/_base/di/instantiation';

export type ModelRole = 'current' | 'default' | 'planning';

export interface CurrentModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string | undefined;
  readonly maxContextSize: number;
  readonly role: ModelRole;
}

export interface ModelListEntry {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string | undefined;
  readonly maxContextSize: number;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly isPlanning: boolean;
}

export type ModelServiceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export type ModelSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface IModelToolsService {
  readonly _serviceBrand: undefined;

  getCurrent(): Promise<ModelServiceResult<CurrentModelInfo>>;
  list(provider?: string): Promise<ModelServiceResult<readonly ModelListEntry[]>>;
  set(model: string, role: ModelRole): Promise<ModelSetResult>;
}

export const IModelToolsService = createDecorator<IModelToolsService>('modelToolsService');
