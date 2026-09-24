/**
 * ZaiWebSearchProvider — host-side `WebSearchProvider` backed by the z.ai
 * search API.
 *
 * z.ai authenticates every request with a bearer API key, so the host passes
 * one in through `apiKey`. `baseUrl` stays overridable for tests and for
 * deployments that proxy the endpoint.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4/web_search';

export interface ZaiWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ZaiSearchResult {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  publish_date?: string;
}

interface ZaiSearchResponse {
  search_result?: ZaiSearchResult[];
}

export class ZaiWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZaiWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify({
        search_engine: 'search-prime',
        search_query: query,
        count: 10,
      }),
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(`Zai search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim());
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(`Zai search request failed: HTTP ${String(response.status)}. ${detail}`.trim());
    }

    const json = (await response.json()) as ZaiSearchResponse;
    const raw = Array.isArray(json.search_result) ? json.search_result : [];

    return raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.link ?? '',
        snippet: r.content ?? '',
      };
      if (typeof r.publish_date === 'string' && r.publish_date.length > 0) {
        out.date = r.publish_date;
      }
      if (typeof r.media === 'string' && r.media.length > 0) out.siteName = r.media;
      return out;
    });
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
