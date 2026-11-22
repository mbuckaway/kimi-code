import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { SERVICES_SECTION, type ServicesConfig } from '#/app/auth/configSection';
import {
  buildAgentIdentitySnapshot,
  IAgentIdentity,
  type AgentIdentitySnapshot,
} from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { DeepseekFetchURLProvider } from '#/app/web/providers/deepseek-fetch-url';
import { MoonshotFetchURLProvider } from '#/app/web/providers/moonshot-fetch-url';
import type { UrlFetcher } from '#/app/web/tools/fetch-url-types';
import { IWebFetchService } from '#/app/web/web';
import { WebFetchService } from '#/app/web/webService';
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { stubAgentIdentity } from '../agentIdentity/stubs';

const OAUTH_PROVIDER = 'managed:kimi-code';
const NON_OAUTH_PROVIDER = 'openai-main';
const HOST_HEADERS = {
  'User-Agent': 'kimi-code-cli/test',
  'X-Msh-Device-Id': 'device-test',
};

describe('WebFetchService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let defaultModel: string | undefined;
  let servicesConfig: ServicesConfig | undefined;
  let identitySlug: string | undefined;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    models = {};
    defaultModel = undefined;
    servicesConfig = undefined;
    identitySlug = undefined;
    resolveTokenProvider = vi
      .fn()
      .mockReturnValue({ getAccessToken: async () => 'access-token' });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
        });
        reg.definePartialInstance(IModelService, {
          get: ((id: string) => models[id]) as IModelService['get'],
          getDefaultModel: (() => defaultModel) as IModelService['getDefaultModel'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        const snapshot = (): AgentIdentitySnapshot =>
          buildAgentIdentitySnapshot({ slug: identitySlug, hostRequestHeaders: HOST_HEADERS });
        reg.defineInstance(IAgentIdentity, {
          _serviceBrand: undefined,
          resolved: () => Promise.resolve(snapshot()),
          current: snapshot,
        });
        reg.definePartialInstance(IBootstrapService, {
          args: { requestHeaders: HOST_HEADERS },
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === SERVICES_SECTION ? servicesConfig : undefined) as IConfigService['get'],
        });
        reg.define(IWebFetchService, WebFetchService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function fetcher(): ReturnType<IWebFetchService['getUrlFetcher']> {
    return ix.get(IWebFetchService).getUrlFetcher();
  }

  it('yields the local fetcher when the managed provider is not configured', () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('yields the local fetcher when the managed provider is not an OAuth kimi provider', () => {
    providers = { [OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('yields the local fetcher when the oauth service yields no token provider', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    resolveTokenProvider.mockReturnValue(undefined);
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
  });

  it('builds a Moonshot fetcher from the managed provider oauth ref', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('fetches against /fetch with the OAuth access token, host identity headers, and custom headers', async () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1/',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => 'page body',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetcher().fetch('https://example.com/page');

    expect(result).toEqual({ content: 'page body', kind: 'extracted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/fetch');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-token');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
  });

  it('builds a Moonshot fetcher from the services.moonshot_fetch api_key config', async () => {
    servicesConfig = {
      moonshotFetch: {
        baseUrl: 'https://fetch.example.com/fetch',
        apiKey: 'fetch-key',
        customHeaders: { 'X-Config': '1' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => 'page body',
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
    const result = await fetcher().fetch('https://example.com/page');

    expect(result).toEqual({ content: 'page body', kind: 'extracted' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fetch.example.com/fetch');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer fetch-key');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Config']).toBe('1');
  });

  it('sends the configured identity to a services-config endpoint', async () => {
    identitySlug = 'acme';
    servicesConfig = {
      moonshotFetch: { baseUrl: 'https://fetch.example.com/fetch', apiKey: 'fetch-key' },
    };
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => 'page body' });
    vi.stubGlobal('fetch', fetchMock);

    await fetcher().fetch('https://example.com/page');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('acme/test');
  });

  it('keeps the host token on the managed oauth endpoint under a custom identity', async () => {
    identitySlug = 'acme';
    providers[OAUTH_PROVIDER] = {
      type: 'kimi',
      baseUrl: 'https://api.example.com/v1',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    };
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => 'page body' });
    vi.stubGlobal('fetch', fetchMock);

    await fetcher().fetch('https://example.com/page');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
  });

  it('prefers the services.moonshot_fetch config over the managed oauth provider', () => {
    servicesConfig = {
      moonshotFetch: { baseUrl: 'https://config.example.com/fetch', apiKey: 'config-key' },
    };
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://managed.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('builds a Moonshot fetcher from the services.moonshot_fetch oauth ref', () => {
    servicesConfig = {
      moonshotFetch: {
        baseUrl: 'https://fetch.example.com/fetch',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('yields the local fetcher when services.moonshot_fetch has no baseUrl and no managed oauth', () => {
    servicesConfig = { moonshotFetch: { apiKey: 'fetch-key' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('builds a deepseek fetcher when the default model is deepseek and the provider has an api key', () => {
    defaultModel = 'deepseek-v4.1-flash';
    models = { 'deepseek-v4.1-flash': { provider: 'deepseek' } };
    providers = {
      deepseek: { type: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key' },
    };
    expect(fetcher()).toBeInstanceOf(DeepseekFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('builds a deepseek fetcher when the default model declares the web_search capability', () => {
    defaultModel = 'custom-model';
    models = { 'custom-model': { provider: 'custom', capabilities: ['web_search'] } };
    providers = { deepseek: { apiKey: 'deepseek-key' } };
    expect(fetcher()).toBeInstanceOf(DeepseekFetchURLProvider);
  });

  it('fetches against the deepseek tools endpoint with the bearer key', async () => {
    defaultModel = 'deepseek-v4.1-flash';
    models = { 'deepseek-v4.1-flash': { provider: 'deepseek' } };
    providers = {
      deepseek: { type: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key' },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ title: 'Title', content: '# Body' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetcher().fetch('https://example.com/page');

    expect(result).toEqual({ content: '# Body', kind: 'extracted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer deepseek-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/page' });
  });

  it('prefers the services.moonshot_fetch config over the deepseek provider', () => {
    servicesConfig = {
      moonshotFetch: { baseUrl: 'https://fetch.example.com/fetch', apiKey: 'fetch-key' },
    };
    defaultModel = 'deepseek-v4.1-flash';
    models = { 'deepseek-v4.1-flash': { provider: 'deepseek' } };
    providers = { deepseek: { type: 'deepseek', apiKey: 'deepseek-key' } };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('keeps the managed oauth fetcher when the default model is not deepseek', () => {
    defaultModel = 'kimi';
    models = { kimi: { provider: OAUTH_PROVIDER } };
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      deepseek: { type: 'deepseek', apiKey: 'deepseek-key' },
    };
    expect(fetcher()).toBeInstanceOf(MoonshotFetchURLProvider);
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('falls back to the local fetcher when the deepseek provider has no api key', () => {
    defaultModel = 'deepseek-v4.1-flash';
    models = { 'deepseek-v4.1-flash': { provider: 'deepseek' } };
    providers = { deepseek: { type: 'deepseek', baseUrl: 'https://api.deepseek.com' } };
    expect(fetcher()).toBeInstanceOf(LocalFetchURLProvider);
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });
});

describe('DeepseekFetchURLProvider', () => {
  const API_KEY = 'YOUR_API_KEY';
  const DEFAULT_URL = 'https://api.deepseek.com/v1/tools/fetch';

  function providerWith(
    fetchMock: ReturnType<typeof vi.fn>,
    localFallback: UrlFetcher,
    baseUrl?: string,
  ): DeepseekFetchURLProvider {
    return new DeepseekFetchURLProvider({
      apiKey: API_KEY,
      baseUrl,
      localFallback,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  }

  function jsonResponse(status: number, payload: unknown) {
    return { status, json: async () => payload, text: async () => '' };
  }

  function fallbackFetcher(content = 'local body') {
    return vi.fn().mockResolvedValue({ content, kind: 'passthrough' as const });
  }

  it('posts the url with the bearer key and returns the extracted markdown content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { title: 'Title', content: '# Body' }));

    const result = await providerWith(fetchMock, { fetch: fallbackFetcher() }).fetch(
      'https://example.com/page',
    );

    expect(result).toEqual({ content: '# Body', kind: 'extracted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEFAULT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/page' });
  });

  it('posts to an overridden baseUrl and forwards the abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { content: 'body' }));
    const controller = new AbortController();

    await providerWith(fetchMock, { fetch: fallbackFetcher() }, 'https://api.example.test/').fetch(
      'https://example.com/page',
      { signal: controller.signal },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/tools/fetch');
    expect(init.signal).toBe(controller.signal);
  });

  it('falls back to the local fetcher on a non-200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 429,
      text: async () => 'slow down',
      json: async () => ({}),
    });
    const localFetch = fallbackFetcher();

    const result = await providerWith(fetchMock, { fetch: localFetch }).fetch(
      'https://example.com/page',
      { toolCallId: 'call-1' },
    );

    expect(result).toEqual({ content: 'local body', kind: 'passthrough' });
    expect(localFetch).toHaveBeenCalledWith('https://example.com/page', {
      toolCallId: 'call-1',
    });
  });

  it('falls back to the local fetcher when the response content is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { title: 'Title' }));
    const localFetch = fallbackFetcher();

    const result = await providerWith(fetchMock, { fetch: localFetch }).fetch(
      'https://example.com/page',
    );

    expect(result).toEqual({ content: 'local body', kind: 'passthrough' });
    expect(localFetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new Error('aborted');
    const fetchMock = vi.fn().mockRejectedValue(failure);
    const localFetch = fallbackFetcher();

    await expect(
      providerWith(fetchMock, { fetch: localFetch }).fetch('https://example.com/page', {
        signal: controller.signal,
      }),
    ).rejects.toThrow(failure);
    expect(localFetch).not.toHaveBeenCalled();
  });
});
