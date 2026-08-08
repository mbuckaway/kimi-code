/**
 * `agentLanguage` domain — resolved language contract.
 *
 * The language the agent uses for replies, resolved from the `[language]`
 * config section and frozen for the life of the process. `current()` returns
 * the `reply_language` value, defaulting to `"en"`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_LANGUAGE = 'en';

export interface IAgentLanguage {
  readonly _serviceBrand: undefined;

  current(): string;
}

export const IAgentLanguage: ServiceIdentifier<IAgentLanguage> =
  createDecorator<IAgentLanguage>('agentLanguage');
