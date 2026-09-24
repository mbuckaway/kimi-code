import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4/web_search';
const SEARCH_ENGINE = 'search-prime';
const RESULT_COUNT = 10;

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

  async search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify({
        search_engine: SEARCH_ENGINE,
        search_query: query,
        count: RESULT_COUNT,
      }),
      signal: options?.signal,
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Zai search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Zai search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    const json = (await response.json()) as ZaiSearchResponse;
    const raw = Array.isArray(json.search_result) ? json.search_result : [];

    return raw.map((item): WebSearchResult => {
      const out: WebSearchResult = {
        title: item.title ?? '',
        url: item.link ?? '',
        snippet: item.content ?? '',
      };
      if (typeof item.publish_date === 'string' && item.publish_date.length > 0) {
        out.date = item.publish_date;
      }
      if (typeof item.media === 'string' && item.media.length > 0) out.siteName = item.media;
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
