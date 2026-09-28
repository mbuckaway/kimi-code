/**
 * QwenWebSearchProvider — host-side `WebSearchProvider` backed by the
 * QwenCloud OpenAI-compatible Responses API and its `web_search` tool.
 *
 * QwenCloud authenticates every request with a bearer API key. `baseUrl` is
 * the OpenAI-compatible base (for example `.../compatible-mode/v1`), not the
 * full path: the provider appends `/responses`. `model` picks the Qwen model
 * that runs the search.
 *
 * The Responses path reports sources as citations only, so `snippet` stays
 * empty for every result.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DEFAULT_BASE_URL = 'https://maas.qwencloudapi.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.8-max';

export interface QwenWebSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface QwenAnnotation {
  type?: string;
  title?: string;
  url?: string;
}

interface QwenOutputTextPart {
  type?: string;
  annotations?: QwenAnnotation[];
}

interface QwenSource {
  title?: string;
  url?: string;
}

interface QwenOutputItem {
  type?: string;
  content?: QwenOutputTextPart[];
  action?: { sources?: QwenSource[] };
}

interface QwenResponsesResponse {
  output?: QwenOutputItem[];
}

interface CollectedSource {
  title: string;
  url: string;
}

export class QwenWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly responsesUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.responsesUrl = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/responses`;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const response = await this.fetchImpl(this.responsesUrl, {
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
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(`Qwen search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim());
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(
        `Qwen search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as QwenResponsesResponse;
    return collectSources(json.output);
  }
}

/**
 * Flatten the output items into cited sources, in first-seen order.
 *
 * One url can arrive as both a citation and a `web_search_call` source, so
 * entries merge per url and keep the first title seen.
 */
function collectSources(output: readonly QwenOutputItem[] | undefined): WebSearchResult[] {
  const byUrl = new Map<string, CollectedSource>();
  for (const item of asArray(output)) {
    if (item.type === 'message') {
      collectCitations(byUrl, item.content);
    } else if (item.type === 'web_search_call') {
      for (const source of asArray(item.action?.sources)) {
        addSource(byUrl, source.url, source.title);
      }
    }
  }
  return [...byUrl.values()].map(({ title, url }) => ({ title, url, snippet: '' }));
}

function collectCitations(
  byUrl: Map<string, CollectedSource>,
  content: readonly QwenOutputTextPart[] | undefined,
): void {
  for (const part of asArray(content)) {
    if (part.type !== 'output_text') continue;
    for (const annotation of asArray(part.annotations)) {
      if (annotation.type !== 'url_citation') continue;
      addSource(byUrl, annotation.url, annotation.title);
    }
  }
}

function addSource(
  byUrl: Map<string, CollectedSource>,
  url: string | undefined,
  title: string | undefined,
): void {
  if (typeof url !== 'string' || url.length === 0) return;
  const existing = byUrl.get(url);
  if (existing === undefined) {
    byUrl.set(url, { title: typeof title === 'string' ? title : '', url });
    return;
  }
  if (existing.title.length === 0 && typeof title === 'string' && title.length > 0) {
    existing.title = title;
  }
}

function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
