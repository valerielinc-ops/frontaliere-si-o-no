// @ts-nocheck
import {
  isRateLimitedError,
  sendEmailCascade,
  PROVIDERS,
} from '../scripts/lib/email-cascade.mjs';

/* ------------------------------------------------------------------ */
/*  isRateLimitedError — burst/quota signal detection                 */
/* ------------------------------------------------------------------ */

describe('isRateLimitedError', () => {
  it('matches the real Mailtrap 403 burst body', () => {
    const msg = 'Mailtrap 403: {"success":false,"errors":["Your account has reached the limit"]}';
    expect(isRateLimitedError(msg)).toBe(true);
  });

  it('matches HTTP 429', () => {
    expect(isRateLimitedError('Mistral 429: rate limited')).toBe(true);
  });

  it('matches 403 with rate/quota keywords', () => {
    expect(isRateLimitedError('Provider 403: rate limit exceeded')).toBe(true);
    expect(isRateLimitedError('Provider 403: monthly quota exhausted')).toBe(true);
  });

  it('does NOT match a generic 403 (e.g. bad domain / auth)', () => {
    expect(isRateLimitedError('Mailtrap 403: {"errors":["Forbidden: domain not verified"]}')).toBe(false);
  });

  it('does NOT match unrelated errors', () => {
    expect(isRateLimitedError('Mailgun 500: internal error')).toBe(false);
    expect(isRateLimitedError('')).toBe(false);
    expect(isRateLimitedError(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Burst mitigation — a 403 "reached" stops re-hitting the provider  */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade burst mitigation', () => {
  const realFetch = globalThis.fetch;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    process.env.MAILTRAP_API_TOKEN = 'test-token';
    // Mock every network call. Mailtrap stats/accounts → benign; send → 403 reached.
    globalThis.fetch = (async (url: string, opts?: any) => {
      calls.push(String(url));
      if (String(url).includes('send.api.mailtrap.io')) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => '{"success":false,"errors":["Your account has reached the limit"]}',
          json: async () => ({ success: false }),
        } as any;
      }
      // accounts / stats lookups during syncQuotasFromAPIs
      if (String(url).includes('/api/accounts')) {
        return { ok: true, status: 200, json: async () => [{ id: 1 }], text: async () => '[]' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILTRAP_API_TOKEN;
  });

  it('hits the Mailtrap send endpoint only once for a 50-email batch', async () => {
    const emails = Array.from({ length: 50 }, (_, i) => ({
      payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' },
      recipient: { email: `r${i}@y.com` },
      meta: {},
    }));

    const { sent, failed } = await sendEmailCascade(emails, {
      forceProvider: 'mailtrap',
      delayMs: 0,
    });

    const sendCalls = calls.filter(u => u.includes('send.api.mailtrap.io')).length;
    // Before the fix: 50 burst calls. After: provider marked exhausted on the
    // first 403 → remainingQuota 0 → every subsequent email is skipped locally.
    expect(sendCalls).toBe(1);
    expect(sent.length).toBe(0);
    expect(failed.length).toBe(50);
  });
});
