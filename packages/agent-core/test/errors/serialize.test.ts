import {
  APIContextOverflowError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '#/errors/codes';
import { toKimiErrorPayload } from '#/errors/serialize';

const NGINX_413_HTML =
  '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
  '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('toKimiErrorPayload — APIStatusError message sanitization', () => {
  it('extracts the <title> from an nginx 413 HTML body and strips CR', () => {
    const payload = toKimiErrorPayload(new APIStatusError(413, NGINX_413_HTML));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('413 Request Entity Too Large');
    expect(payload.details).toMatchObject({ statusCode: 413 });
  });

  it('extracts the <title> from other nginx HTML error pages', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
      '<body><center><h1>502 Bad Gateway</h1></center></body></html>';
    const payload = toKimiErrorPayload(new APIStatusError(502, html));
    expect(payload.message).toBe('502 Bad Gateway');
  });

  it('leaves a plain-text message unchanged', () => {
    const payload = toKimiErrorPayload(new APIStatusError(500, 'Internal Server Error'));
    expect(payload.message).toBe('Internal Server Error');
  });

  it('strips carriage returns from a non-HTML message', () => {
    const payload = toKimiErrorPayload(new APIStatusError(500, 'line1\r\nline2\r'));
    expect(payload.message).toBe('line1\nline2');
  });

  it('falls back to the original message when the <title> is empty', () => {
    const html = '<html><head><title>   </title></head><body>x</body></html>';
    const payload = toKimiErrorPayload(new APIStatusError(500, html));
    expect(payload.message).toContain('<html>');
  });

  it('does not affect 429 / 401 code mapping, only the message', () => {
    const html = '<html><head><title>429 Too Many Requests</title></head></html>';
    expect(toKimiErrorPayload(new APIStatusError(429, html)).code).toBe('provider.rate_limit');
    expect(toKimiErrorPayload(new APIStatusError(401, 'Unauthorized')).code).toBe(
      'provider.auth_error',
    );
  });

  it('maps a context-limit 401 (APIContextOverflowError) to context.overflow, not auth', () => {
    const payload = toKimiErrorPayload(
      new APIContextOverflowError(401, 'k3-256k supports only 256K context.'),
    );
    expect(payload.code).toBe(ErrorCodes.CONTEXT_OVERFLOW);
    expect(payload.message).toBe('k3-256k supports only 256K context.');
    expect(payload.details).toMatchObject({ statusCode: 401 });
  });
});

describe('toKimiErrorPayload — quota-exhausted 429', () => {
  it('maps a quota-exhausted 429 to provider.usage_limit, not provider.rate_limit', () => {
    // provider.rate_limit is retryable and re-minted as a rate-limit error
    // across the wire boundary, which drives the swarm requeue/suspend loop;
    // quota exhaustion carries the dedicated non-retryable code instead.
    const payload = toKimiErrorPayload(
      new APIProviderQuotaExhaustedError(
        'Your account is suspended due to insufficient balance, please recharge your account',
        'req-quota',
      ),
    );
    expect(payload.code).toBe('provider.usage_limit');
    expect(payload.retryable).toBe(false);
    expect(payload.message).toContain('recharge');
    expect(payload.details).toMatchObject({ statusCode: 429, requestId: 'req-quota' });
  });

  it('maps the #2121 managed-subscription 403 usage-limit failure to provider.usage_limit', () => {
    // classifyKimiQuotaError promotes the 403 "usage limit for this billing
    // cycle" response to APIProviderQuotaExhaustedError; serialization must
    // keep it out of provider.rate_limit even though the message could match
    // rate-limit wording downstream.
    const payload = toKimiErrorPayload(
      new APIProviderQuotaExhaustedError(
        "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan.",
        'req-usage',
      ),
    );
    expect(payload.code).toBe('provider.usage_limit');
    expect(payload.retryable).toBe(false);
    expect(payload.message).toContain('usage limit');
    expect(payload.details).toMatchObject({ requestId: 'req-usage' });
  });
});
