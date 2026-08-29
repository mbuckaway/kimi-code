import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const KIMI_OAUTH_FLAG_ID = 'kimi_oauth';
export const KIMI_OAUTH_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_KIMI_OAUTH';

export const kimiOAuthFlag: FlagDefinitionInput = {
  id: KIMI_OAUTH_FLAG_ID,
  title: 'Kimi OAuth login',
  description:
    'Allow device-code OAuth login to kimi.com / kimi.ai. Disabled by default; token/apiKey auth remains the default.',
  env: KIMI_OAUTH_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(kimiOAuthFlag);
