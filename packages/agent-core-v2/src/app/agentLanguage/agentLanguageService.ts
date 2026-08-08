/**
 * `agentLanguage` domain — `IAgentLanguage` implementation.
 *
 * Builds the process-lifetime language snapshot from the `[language]` config
 * section, once config has first loaded; later `[language]` edits take effect
 * on the next start. Bound at App scope, activated eagerly so the freeze is
 * armed before any consumer can observe config readiness.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';

import { DEFAULT_LANGUAGE, IAgentLanguage } from './agentLanguage';
import { LANGUAGE_SECTION, type LanguageConfig } from './configSection';

export class AgentLanguageService implements IAgentLanguage {
  declare readonly _serviceBrand: undefined;

  private language: string | undefined;
  private readonly frozen: Promise<string>;

  constructor(
    @IConfigService config: IConfigService,
  ) {
    this.frozen = config.ready
      .catch(() => undefined)
      .then(() => {
        const section = config.get<LanguageConfig | undefined>(LANGUAGE_SECTION) ?? {};
        const raw = section.reply_language?.trim();
        this.language = raw !== undefined && raw.length > 0 ? raw : DEFAULT_LANGUAGE;
        return this.language;
      });
  }

  resolved(): Promise<string> {
    return this.frozen;
  }

  current(): string {
    if (this.language === undefined) {
      throw new Error2(
        CoreErrors.codes.INTERNAL,
        'agent language read before config load completed',
      );
    }
    return this.language;
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentLanguage,
  AgentLanguageService,
  ScopeActivation.OnScopeCreated,
  'agentLanguage',
);
