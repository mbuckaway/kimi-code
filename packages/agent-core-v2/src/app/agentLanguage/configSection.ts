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
