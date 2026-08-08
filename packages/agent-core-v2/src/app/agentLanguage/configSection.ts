/**
 * `agentLanguage` domain — the `[language]` config section.
 *
 * Owns the `reply_language` preference: which language the agent replies in.
 * Binds to `KIMI_CODE_REPLY_LANGUAGE` so a container or CI run can set a
 * language without writing `config.toml`; an env override never persists back
 * into the file. Leaving the section unset means English.
 *
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const LANGUAGE_SECTION = 'language';

export const LanguageConfigSchema = z.object({
  reply_language: z.string().optional(),
});

export type LanguageConfig = z.infer<typeof LanguageConfigSchema>;

export const REPLY_LANGUAGE_ENV = 'KIMI_CODE_REPLY_LANGUAGE';

function parseReplyLanguageEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const languageEnvBindings: EnvBindings<LanguageConfig> = envBindings(
  LanguageConfigSchema,
  {
    reply_language: { env: REPLY_LANGUAGE_ENV, parse: parseReplyLanguageEnv },
  },
);

export const stripLanguageEnv = stripEnvBoundFields(languageEnvBindings);

registerConfigSection(LANGUAGE_SECTION, LanguageConfigSchema, {
  defaultValue: { reply_language: 'en' },
  env: languageEnvBindings,
  stripEnv: stripLanguageEnv,
});
