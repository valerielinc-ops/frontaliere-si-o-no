// @ts-nocheck
import {
  isRateLimitedError,
  isProviderMisconfiguredError,
  sendEmailCascade,
  fetchMailtrapDailyUsage,
  fetchCloudflareUsage,
  fetchCloudflareDeliveryStats,
  campaignIdTag,
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

  it('does NOT match a 403 with bare "reached" lacking limit/quota context', () => {
    // e.g. a network-style 403 body — must not retire a healthy provider.
    expect(isRateLimitedError('Mailgun 403: {"errors":["upstream host could not be reached"]}')).toBe(false);
  });

  it('does NOT match unrelated errors', () => {
    expect(isRateLimitedError('Mailgun 500: internal error')).toBe(false);
    expect(isRateLimitedError('')).toBe(false);
    expect(isRateLimitedError(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  isProviderMisconfiguredError — deterministic per-run config errors */
/* ------------------------------------------------------------------ */

describe('isProviderMisconfiguredError', () => {
  it('matches the CF sender-not-onboarded error (10202 email.invalid)', () => {
    expect(isProviderMisconfiguredError('Cloudflare 400 code=10202: email.sending.error.email.invalid')).toBe(true);
  });

  it('matches the CF invalid request schema error (10001)', () => {
    expect(isProviderMisconfiguredError('Cloudflare 400 code=10001: email.sending.error.invalid_request_schema')).toBe(true);
  });

  it('does NOT match a transient CF rate-limit (10004) — that path is the rate-limit retirement', () => {
    expect(isProviderMisconfiguredError('Cloudflare 429 code=10004: throttled')).toBe(false);
  });

  it('does NOT match unrelated provider errors', () => {
    expect(isProviderMisconfiguredError('Mailgun 500: internal error')).toBe(false);
    expect(isProviderMisconfiguredError('')).toBe(false);
    expect(isProviderMisconfiguredError(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  fetchMailtrapDailyUsage — delivery_count lag must not under-count  */
/* ------------------------------------------------------------------ */

describe('fetchMailtrapDailyUsage', () => {
  const realFetch = globalThis.fetch;

  function mockStats(stats: Record<string, unknown>) {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/api/accounts/')) {
        return { ok: true, status: 200, json: async () => stats } as any;
      }
      // GET /api/accounts → account list
      return { ok: true, status: 200, json: async () => [{ id: 1 }] } as any;
    }) as any;
  }

  beforeEach(() => { process.env.MAILTRAP_API_TOKEN = 'test-token'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILTRAP_API_TOKEN;
  });

  it('uses sent_count when delivery_count lags behind real sends', async () => {
    // The bug: delivery confirmations arrive async, so delivery_count=1 while 31
    // were actually sent. Gating on delivery_count alone would report 1 → over-send.
    mockStats({ sent_count: 31, delivery_count: 1, bounce_count: 0 });
    expect(await fetchMailtrapDailyUsage()).toBe(31);
  });

  it('counts bounced sends when no sent_count is present (no regression)', async () => {
    mockStats({ delivery_count: 10, bounce_count: 2 });
    expect(await fetchMailtrapDailyUsage()).toBe(12);
  });

  it('returns 0 when no token is configured', async () => {
    delete process.env.MAILTRAP_API_TOKEN;
    expect(await fetchMailtrapDailyUsage()).toBe(0);
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

/* ------------------------------------------------------------------ */
/*  Cloudflare Email Service provider                                  */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — cloudflare provider', () => {
  const realFetch = globalThis.fetch;
  const CF_SEND = '/email/sending/send';

  beforeEach(() => {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = 'cf-test-token';
    process.env.CF_ACCOUNT_ID = 'acc-123';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
  });

  it('sends via the account-scoped REST endpoint and returns the real message_id', async () => {
    let sendUrl = '';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes(CF_SEND)) {
        sendUrl = String(url);
        const body = JSON.parse(opts.body);
        // CF rejects the { email, name } object form with 400 invalid_request_schema
        // (verified live 2026-06-16): from/to MUST be RFC822 strings.
        expect(body.from).toBe('Frontaliere <a@b.ch>');
        expect(body.to).toEqual(['x@y.com']);
        // Real envelope: success + result.message_id even when delivered/queued empty.
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, errors: [], result: { message_id: '<abc@frontaliereticino.ch>', delivered: [], queued: [], permanent_bounces: [] } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{ payload: { from: 'Frontaliere <a@b.ch>', to: ['x@y.com'], subject: 's', html: '<p>h</p>' }, recipient: { email: 'x@y.com' }, meta: {} }],
      { forceProvider: 'cloudflare', delayMs: 0 },
    );

    expect(sendUrl).toContain('/accounts/acc-123/email/sending/send');
    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(sent[0].provider).toBe('cloudflare');
    expect(sent[0].messageId).toBe('<abc@frontaliereticino.ch>');
  });

  it('falls back to the default CF_API_TOKEN when no dedicated token is set', async () => {
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
    process.env.CF_API_TOKEN = 'default-cf-token';
    let auth = '';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes(CF_SEND)) {
        auth = opts.headers.Authorization;
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, result: { message_id: '<m@frontaliereticino.ch>' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent } = await sendEmailCascade(
      [{ payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' }, recipient: { email: 'x@y.com' }, meta: {} }],
      { forceProvider: 'cloudflare', delayMs: 0 },
    );

    expect(auth).toBe('Bearer default-cf-token');
    expect(sent.length).toBe(1);
    delete process.env.CF_API_TOKEN;
  });

  it('retires cloudflare after a 429 throttle (no burst across a batch)', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes(CF_SEND)) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => '{"errors":[{"code":10004,"message":"email.sending.error.throttled"}]}',
          json: async () => ({ success: false }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const emails = Array.from({ length: 10 }, (_, i) => ({
      payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' },
      recipient: { email: `r${i}@y.com` },
      meta: {},
    }));

    const { sent, failed } = await sendEmailCascade(emails, { forceProvider: 'cloudflare', delayMs: 0 });

    const sendCalls = calls.filter(u => u.includes(CF_SEND)).length;
    expect(sendCalls).toBe(1); // 429 → provider exhausted → rest skipped locally
    expect(sent.length).toBe(0);
    expect(failed.length).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/*  Cloudflare delivery-event observation (GraphQL Analytics, pull)    */
/* ------------------------------------------------------------------ */

describe('fetchCloudflareUsage / fetchCloudflareDeliveryStats', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = 'cf-test-token';
    process.env.CF_ACCOUNT_ID = 'acc-123';
    process.env.CF_ZONE_ID = 'zone-123'; // skip the zone-lookup network call
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
    delete process.env.CF_EMAIL_API_TOKEN;
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
    delete process.env.CF_ZONE_ID;
  });

  // emailSendingAdaptiveGroups is ZONE-scoped → response shape is viewer.zones[].
  function mockGraphQL(groups: any[]) {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { viewer: { zones: [{ emailSendingAdaptiveGroups: groups }] } } }),
    })) as any;
  }

  it('sums total send events for fetchCloudflareUsage', async () => {
    mockGraphQL([{ count: 12 }, { count: 8 }]);
    expect(await fetchCloudflareUsage('2026-06-01', '2026-06-16')).toBe(20);
  });

  it('breaks down delivery status for fetchCloudflareDeliveryStats', async () => {
    mockGraphQL([
      { count: 40, dimensions: { status: 'delivered' } },
      { count: 3, dimensions: { status: 'bounced' } },
      { count: 1, dimensions: { status: 'failed' } },
    ]);
    const stats = await fetchCloudflareDeliveryStats('2026-06-16', '2026-06-16');
    expect(stats).toEqual({ total: 44, byStatus: { delivered: 40, bounced: 3, failed: 1 } });
  });

  it('resolves the zone id by domain when CF_ZONE_ID is unset', async () => {
    delete process.env.CF_ZONE_ID;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/zones?')) {
        return { ok: true, status: 200, json: async () => ({ result: [{ id: 'zone-resolved' }] }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { zones: [{ emailSendingAdaptiveGroups: [{ count: 5 }] }] } } }) } as any;
    }) as any;
    expect(await fetchCloudflareUsage('2026-06-16', '2026-06-16')).toBe(5);
    expect(urls.some(u => u.includes('/zones?name='))).toBe(true);
  });

  it('returns null (not 0) when unconfigured so callers can tell "couldn\'t verify"', async () => {
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_EMAIL_API_TOKEN;
    expect(await fetchCloudflareUsage('2026-06-16', '2026-06-16')).toBeNull();
    expect(await fetchCloudflareDeliveryStats('2026-06-16', '2026-06-16')).toBeNull();
  });

  it('returns null when the GraphQL response carries errors', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'auth' }] }),
    })) as any;
    expect(await fetchCloudflareDeliveryStats('2026-06-16', '2026-06-16')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  campaignIdTag — single-token providers stamp the weekly_* id       */
/* ------------------------------------------------------------------ */

describe('campaignIdTag', () => {
  it('resolves the campaign_id tag BY NAME regardless of position', () => {
    // Order intentionally NOT campaign-id-first → positional tags[0] would be wrong.
    const email = {
      tags: [
        { name: 'subscriber_locale', value: 'it' },
        { name: 'variant', value: 'b' },
        { name: 'campaign_id', value: 'weekly_2026-06-15' },
      ],
    };
    expect(campaignIdTag(email)).toBe('weekly_2026-06-15');
  });

  it('matches the newsletter pipeline order (campaign_id first)', () => {
    const email = {
      tags: [
        { name: 'campaign_id', value: 'weekly_2026-06-15' },
        { name: 'subscriber_locale', value: 'de' },
      ],
    };
    expect(campaignIdTag(email)).toBe('weekly_2026-06-15');
  });

  it('falls back to the first tag for single-tag callers', () => {
    expect(campaignIdTag({ tags: [{ name: 'job-alert', value: 'job-alert' }] })).toBe('job-alert');
  });

  it('returns undefined when there are no tags', () => {
    expect(campaignIdTag({})).toBeUndefined();
    expect(campaignIdTag({ tags: [] })).toBeUndefined();
    expect(campaignIdTag(undefined)).toBeUndefined();
  });
});
