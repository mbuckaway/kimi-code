import { APIContextOverflowError, APIStatusError } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '#/errors/codes';
import { ProviderManager } from '#/session/provider-manager';
import type { KimiConfig } from '#/config';

function makeOAuthProviderManager(): ProviderManager {
  const tokenProvider = { getAccessToken: async () => 'tok' };
  return new ProviderManager({
    config: {
      providers: {
        kimi: {
          type: 'kimi',
          model: 'kimi-code/k3-256k',
          oauth: { storage: 'file', key: 'kimi' },
        },
      },
      models: {
        'kimi-code/k3-256k': {
          provider: 'kimi',
          model: 'kimi-code/k3-256k',
          maxContextSize: 262144,
        },
      },
    } as KimiConfig,
    resolveOAuthTokenProvider: () => tokenProvider,
  });
}

describe('ProviderManager.resolveAuth — 401 refresh gate', () => {
  it('does not force a token refresh for a context-limit 401', async () => {
    const manager = makeOAuthProviderManager();
    const withAuth = manager.resolveAuth('kimi-code/k3-256k');
    expect(withAuth).toBeDefined();

    let calls = 0;
    const failure = await withAuth!(async () => {
      calls += 1;
      throw new APIContextOverflowError(401, 'k3-256k supports only 256K context.');
    }).catch((error: unknown) => error);

    // The context-overflow error passes through untouched: no refresh, no
    // reclassification into provider.auth_error (issue #2613).
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(APIContextOverflowError);
    expect((failure as APIContextOverflowError).message).toContain('supports only 256K context');
  });

  it('still refreshes once and surfaces provider.auth_error for a plain 401', async () => {
    const manager = makeOAuthProviderManager();
    const withAuth = manager.resolveAuth('kimi-code/k3-256k');
    expect(withAuth).toBeDefined();

    let calls = 0;
    const failure = await withAuth!(async () => {
      calls += 1;
      throw new APIStatusError(401, 'account rejected');
    }).catch((error: unknown) => error);

    expect(calls).toBe(2);
    expect(failure).toMatchObject({ code: ErrorCodes.PROVIDER_AUTH_ERROR });
    expect((failure as Error).message).toContain('account rejected');
  });
});
