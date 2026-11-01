import { Error2, ErrorCodes } from '#/errors';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../tools/fetch-url-types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const FETCH_PATH = '/v1/tools/fetch';

export interface DeepseekFetchURLProviderOptions {
  apiKey: string;
  baseUrl?: string;
  localFallback: UrlFetcher;
  fetchImpl?: typeof fetch;
}

interface DeepseekFetchResponse {
  title?: string;
  content?: string;
}

export class DeepseekFetchURLProvider implements UrlFetcher {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly localFallback: UrlFetcher;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepseekFetchURLProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${FETCH_PATH}`;
    this.localFallback = options.localFallback;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    try {
      const content = await this.fetchViaDeepseek(url, options?.signal);
      return { content, kind: 'extracted' };
    } catch (error) {
      if (options?.signal?.aborted === true) throw error;
      return this.localFallback.fetch(url, options ?? {});
    }
  }

  private async fetchViaDeepseek(url: string, signal: AbortSignal | undefined): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
      signal,
    });

    if (response.status !== 200) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
      }
      throw new HttpFetchError(
        response.status,
        `Deepseek fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as DeepseekFetchResponse;
    if (typeof json.content !== 'string' || json.content.length === 0) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        'Deepseek fetch response is missing content.',
      );
    }
    return json.content;
  }
}
