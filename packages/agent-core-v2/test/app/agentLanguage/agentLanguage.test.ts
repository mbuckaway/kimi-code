/**
 * Scenario: agent language resolution.
 *
 * Asserts the language the agent uses for replies, resolved from the
 * `[language]` config section and frozen once config first loads — plus the
 * freeze itself: a `[language]` edit after the freeze changes nothing until the
 * next start, and a synchronous read before the freeze fails loudly instead of
 * serving a pre-config value. The `reply_language` field defaults to `"en"` and
 * blank / whitespace values fall back to the default.
 *
 * The env override is asserted on the exported domain surface:
 * `KIMI_CODE_REPLY_LANGUAGE` binds `reply_language` through a parse that trims
 * padding and rejects blank values, and `stripLanguageEnv` keeps an env-set
 * field out of persisted writes so the env read path keeps applying.
 *
 * Runs the real `AgentLanguageService` over a stub config service; nothing else
 * is wired. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentLanguage/agentLanguage.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import {
  DEFAULT_LANGUAGE,
  IAgentLanguage,
} from '#/app/agentLanguage/agentLanguage';
import { AgentLanguageService } from '#/app/agentLanguage/agentLanguageService';
import {
  LANGUAGE_SECTION,
  languageEnvBindings,
  REPLY_LANGUAGE_ENV,
  stripLanguageEnv,
} from '#/app/agentLanguage/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService } from '#/_base/di/scope';

import { stubBootstrap } from '../bootstrap/stubs';
import { StubConfigService } from '../../kosong/stubs';

const hosts: Array<{ dispose(): void }> = [];

afterEach(() => {
  while (hosts.length > 0) hosts.pop()?.dispose();
});

function createLanguage(
  section: Record<string, unknown> | undefined,
): { language: IAgentLanguage; config: StubConfigService } {
  registerScopedService(LifecycleScope.App, IAgentLanguage, AgentLanguageService);
  const config = new StubConfigService(
    section === undefined ? {} : { [LANGUAGE_SECTION]: section },
  );
  const host = createScopedTestHost([
    [IConfigService, config],
    [IBootstrapService, stubBootstrap('/home')],
  ]);
  hosts.push(host);
  return { language: host.app.accessor.get(IAgentLanguage), config };
}

async function resolve(
  section: Record<string, unknown> | undefined,
): Promise<string> {
  const { language } = createLanguage(section);
  await (language as AgentLanguageService).resolved?.();
  return language.current();
}

describe('AgentLanguageService', () => {
  it('returns "en" when the section is unset', async () => {
    const lang = await resolve(undefined);
    expect(lang).toBe('en');
  });

  it('returns the configured reply_language', async () => {
    const lang = await resolve({ reply_language: 'zh' });
    expect(lang).toBe('zh');
  });

  it('returns "auto" when configured as auto', async () => {
    const lang = await resolve({ reply_language: 'auto' });
    expect(lang).toBe('auto');
  });

  it('falls back to "en" when reply_language is blank', async () => {
    const lang = await resolve({ reply_language: '' });
    expect(lang).toBe('en');
  });

  it('falls back to "en" when reply_language is whitespace-only', async () => {
    const lang = await resolve({ reply_language: '   ' });
    expect(lang).toBe('en');
  });

  it('trims a padded reply_language value', async () => {
    const lang = await resolve({ reply_language: '  zh  ' });
    expect(lang).toBe('zh');
  });
});

describe('AgentLanguageService freeze', () => {
  it('ignores a config edit made after the freeze', async () => {
    const { language, config } = createLanguage({ reply_language: 'zh' });
    await (language as AgentLanguageService).resolved();
    const before = language.current();
    expect(before).toBe('zh');

    await config.set(LANGUAGE_SECTION, { reply_language: 'ja' });

    const after = language.current();
    expect(after).toBe(before);
    expect(language.current()).toBe('zh');
  });

  it('throws on a synchronous read before the freeze', () => {
    const { language } = createLanguage({ reply_language: 'zh' });
    expect(() => language.current()).toThrow(/before config load/);
  });

  it('serves the synchronous read once the freeze has delivered', async () => {
    const { language } = createLanguage({ reply_language: 'zh' });
    // Config is already ready synchronously with the stub, so this resolves
    // immediately.
    await (language as AgentLanguageService).resolved?.();
    expect(language.current()).toBe('zh');
  });
});

describe('DEFAULT_LANGUAGE', () => {
  it('is "en"', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
  });
});

// `languageEnvBindings` is typed as the `EnvBindings<LanguageConfig>` union;
// the section binds exactly one leaf field, so narrow the exported object to
// that leaf's `{ env, parse }` shape to inspect the env-override contract.
type LanguageEnvBinding = {
  readonly env: string;
  readonly parse: (raw: string) => string | undefined;
};

describe('REPLY_LANGUAGE_ENV', () => {
  it('is "KIMI_CODE_REPLY_LANGUAGE"', () => {
    expect(REPLY_LANGUAGE_ENV).toBe('KIMI_CODE_REPLY_LANGUAGE');
  });
});

describe('language env binding', () => {
  const replyLanguageBinding = (
    languageEnvBindings as unknown as { readonly reply_language: LanguageEnvBinding }
  ).reply_language;

  it('maps reply_language to REPLY_LANGUAGE_ENV with a parse function and no extra fields', () => {
    expect(languageEnvBindings).toEqual({
      reply_language: { env: REPLY_LANGUAGE_ENV, parse: expect.any(Function) },
    });
  });

  describe('parse', () => {
    it('trims padding around the language', () => {
      expect(replyLanguageBinding.parse(' fr ')).toBe('fr');
    });

    it('returns undefined for an empty string', () => {
      expect(replyLanguageBinding.parse('')).toBeUndefined();
    });

    it('returns undefined for a whitespace-only string', () => {
      expect(replyLanguageBinding.parse('   ')).toBeUndefined();
    });

    it('passes "auto" through untouched', () => {
      expect(replyLanguageBinding.parse('auto')).toBe('auto');
    });
  });
});

describe('stripLanguageEnv', () => {
  const stubEnv =
    (raw: string | undefined) =>
    (name: string): string | undefined =>
      name === REPLY_LANGUAGE_ENV ? raw : undefined;

  it('strips reply_language when the env var is set and the file has none', () => {
    expect(stripLanguageEnv({ reply_language: 'fr' }, undefined, stubEnv('fr'))).toBeUndefined();
  });

  it('restores the file value over an env echo when one is present', () => {
    expect(
      stripLanguageEnv({ reply_language: 'fr' }, { reply_language: 'zh' }, stubEnv('fr')),
    ).toEqual({ reply_language: 'zh' });
  });

  it('leaves the value untouched when the env var is unset', () => {
    const value = { reply_language: 'zh' };
    expect(stripLanguageEnv(value, undefined, stubEnv(undefined))).toBe(value);
  });

  it('leaves the value untouched when the env value fails to parse', () => {
    const value = { reply_language: 'en' };
    expect(stripLanguageEnv(value, undefined, stubEnv('   '))).toBe(value);
  });

  it('leaves the value untouched when no env accessor is provided', () => {
    const value = { reply_language: 'zh' };
    expect(stripLanguageEnv(value)).toBe(value);
  });
});
