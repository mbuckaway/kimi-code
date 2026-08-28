import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_LANGUAGE = 'en';

export interface IAgentLanguage {
  readonly _serviceBrand: undefined;

  current(): string;
}

export const IAgentLanguage: ServiceIdentifier<IAgentLanguage> =
  createDecorator<IAgentLanguage>('agentLanguage');
