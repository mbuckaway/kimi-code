import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

const DEFAULT_BASE_URL = 'https://maas.qwencloudapi.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.8-max';
const RESPONSES_PATH = '/responses';

export interface QwenWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface QwenUrlCitation {
  type?: string;
  title?: string;
  url?: string;
}

interface QwenOutputTextPart {
  type?: string;
  text?: string;
  annotations?: QwenUrlCitation[];
}

interface QwenSource {
  url?: string;
  title?: string;
}

interface QwenOutputItem {
  type?: string;
  content?: QwenOutputTextPart[];
  action?: {
    query?: string;
    sources?: QwenSource[];
  };
}

interface QwenSearchResponse {
  output?: QwenOutputItem[];
}

export class QwenWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${RESPONSES_PATH}`;
    this.model = options.model ?? DEFAULT_MODEL;
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
      },
      body: JSON.stringify({
        model: this.model,
        input: query,
        tools: [{ type: 'web_search' }],
        stream: false,
      }),
      signal: options?.signal,
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Qwen search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Qwen search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
        { details: { status: response.status } },
      );
    }

    const json = (await response.json()) as QwenSearchResponse;
    const items = Array.isArray(json.output) ? json.output : [];
    const byUrl = new Map<string, WebSearchResult>();

    for (const item of items) {
      if (item.type === 'web_search_call') {
        const sources = item.action?.sources;
        if (!Array.isArray(sources)) continue;
        for (const source of sources) addResult(byUrl, source.url, source.title);
        continue;
      }
      if (item.type === 'message') {
        const parts = item.content;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (part.type !== 'output_text') continue;
          const annotations = part.annotations;
          if (!Array.isArray(annotations)) continue;
          for (const annotation of annotations) {
            if (annotation.type !== 'url_citation') continue;
            addResult(byUrl, annotation.url, annotation.title);
          }
        }
      }
    }

    return [...byUrl.values()];
  }
}

function addResult(
  byUrl: Map<string, WebSearchResult>,
  url: string | undefined,
  title: string | undefined,
): void {
  if (typeof url !== 'string' || url.length === 0) return;
  const normalizedTitle = typeof title === 'string' ? title : '';
  const existing = byUrl.get(url);
  if (existing === undefined) {
    byUrl.set(url, { title: normalizedTitle, url, snippet: '' });
    return;
  }
  if (existing.title.length === 0 && normalizedTitle.length > 0) existing.title = normalizedTitle;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
