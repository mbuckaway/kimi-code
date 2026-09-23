import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import {
  SERVICES_SECTION,
  type SearchProviderId,
  type ServicesConfig,
} from '../configSection';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import { ZaiWebSearchProvider } from './providers/zai-web-search';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.search;
    switch (searchSelectionOf(search?.provider)) {
      case 'moonshot':
        return this.moonshotProvider();
      case 'disabled':
        return undefined;
      case 'zai':
        return this.zaiProvider(search?.apiKey);
    }
  }

  hasWebSearchProvider(): boolean {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.search;
    switch (searchSelectionOf(search?.provider)) {
      case 'moonshot':
        return this.configuredSearch() !== undefined || this.managedTokenProvider() !== undefined;
      case 'disabled':
        return false;
      case 'zai':
        return this.zaiProvider(search?.apiKey) !== undefined;
    }
  }

  private moonshotProvider(): WebSearchProvider | undefined {
    return this.fromServicesConfig() ?? this.fromManagedOAuth();
  }

  private zaiProvider(apiKey: string | undefined): ZaiWebSearchProvider | undefined {
    const key = nonEmptyString(apiKey);
    return key === undefined ? undefined : new ZaiWebSearchProvider({ apiKey: key });
  }

  private configuredSearch(): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) return undefined;
    return search as ServicesConfig['moonshotSearch'] & { baseUrl: string };
  }

  private managedTokenProvider():
    | { provider: ProviderConfig; tokenProvider: BearerTokenProvider }
    | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) return undefined;
    return { provider, tokenProvider };
  }

  private fromServicesConfig(): WebSearchProvider | undefined {
    const search = this.configuredSearch();
    if (search === undefined) return undefined;
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: search.customHeaders,
    });
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
    const managed = this.managedTokenProvider();
    if (managed === undefined) return undefined;
    const { provider, tokenProvider } = managed;
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.bootstrap.args.requestHeaders },
      customHeaders: provider.customHeaders,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

type SearchSelection = 'moonshot' | 'disabled' | 'zai';

const SEARCH_SELECTIONS: Record<SearchProviderId, SearchSelection> = {
  kimi: 'moonshot',
  disabled: 'disabled',
  zai: 'zai',
};

function searchSelectionOf(provider: SearchProviderId | undefined): SearchSelection {
  return provider === undefined ? 'moonshot' : SEARCH_SELECTIONS[provider];
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
