import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const SEARCH_PATH = '/v1/tools/search';
const RESULT_COUNT = 10;

export interface DeepseekWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface DeepseekSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  site_name?: string;
  date?: string;
}

interface DeepseekSearchResponse {
  results?: DeepseekSearchResult[];
}

export class DeepseekWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepseekWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${SEARCH_PATH}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        count: RESULT_COUNT,
        need_content: false,
      }),
      signal: options?.signal,
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Deepseek search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Deepseek search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    const json = (await response.json()) as DeepseekSearchResponse;
    const raw = Array.isArray(json.results) ? json.results : [];

    return raw.map((item): WebSearchResult => {
      const summary =
        typeof item.summary === 'string' && item.summary.length > 0 ? item.summary : item.snippet;
      const out: WebSearchResult = {
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: summary ?? '',
      };
      if (typeof item.date === 'string' && item.date.length > 0) out.date = item.date;
      if (typeof item.site_name === 'string' && item.site_name.length > 0) {
        out.siteName = item.site_name;
      }
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
