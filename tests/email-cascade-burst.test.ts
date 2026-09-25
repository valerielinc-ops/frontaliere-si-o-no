// @ts-nocheck
import {
  isRateLimitedError,
  sendEmailCascade,
  fetchMailtrapDailyUsage,
  fetchResendDailyUsage,
  fetchCloudflareUsage,
  fetchCloudflareDeliveryStats,
  campaignIdTag,
  PROVIDERS,
  remainingQuota,
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

  it('does NOT match Cloudflare code=10004 (soft burst throttle, handled by cooldown instead)', () => {
    expect(isRateLimitedError('Cloudflare 429 code=10004: email.sending.error.throttled')).toBe(false);
  });

  it('does NOT match unrelated errors', () => {
    expect(isRateLimitedError('Mailgun 500: internal error')).toBe(false);
    expect(isRateLimitedError('')).toBe(false);
    expect(isRateLimitedError(undefined)).toBe(false);
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
/*  fetchResendDailyUsage — must paginate past the API's default      */
/*  20-item page instead of silently under-counting today's sends     */
/* ------------------------------------------------------------------ */

describe('fetchResendDailyUsage', () => {
  const realFetch = globalThis.fetch;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  function entry(id, dateStr) {
    return { id, created_at: `${dateStr}T10:00:00.000Z` };
  }

  beforeEach(() => { process.env.RESEND_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  it('counts past the default 20-item page across multiple pages', async () => {
    let calls = 0;
    globalThis.fetch = (async (url) => {
      calls++;
      if (calls === 1) {
        expect(String(url)).toContain('limit=100');
        expect(String(url)).not.toContain('after=');
        const page = Array.from({ length: 100 }, (_, i) => entry(`p1-${i}`, today));
        return { ok: true, json: async () => ({ data: page, has_more: true }) };
      }
      expect(String(url)).toContain(`after=p1-99`);
      const page = Array.from({ length: 50 }, (_, i) => entry(`p2-${i}`, today));
      return { ok: true, json: async () => ({ data: page, has_more: false }) };
    });
    expect(await fetchResendDailyUsage()).toBe(150);
    expect(calls).toBe(2);
  });

  it('stops at the first entry from a previous day without fetching another page', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const page = [
        ...Array.from({ length: 30 }, (_, i) => entry(`today-${i}`, today)),
        ...Array.from({ length: 10 }, (_, i) => entry(`yesterday-${i}`, yesterday)),
      ];
      return { ok: true, json: async () => ({ data: page, has_more: true }) };
    });
    expect(await fetchResendDailyUsage()).toBe(30);
    expect(calls).toBe(1);
  });

  it('returns 0 when no API key is configured', async () => {
    delete process.env.RESEND_API_KEY;
    expect(await fetchResendDailyUsage()).toBe(0);
  });

  it('returns 0 on a failed request', async () => {
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }));
    expect(await fetchResendDailyUsage()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Burst mitigation — a 403 "reached" stops re-hitting the provider  */
/*  Vehicle: maileroo (mailtrap itself was removed from PROVIDERS     */
/*  2026-07-29 — send stream suspended, silently swallowed mail — see */
/*  the PROVIDERS comment in functions/src/emailCascade.js). This     */
/*  test is about the generic benching behaviour in sendSingle(), not */
/*  about mailtrap specifically, so any still-cascaded provider is a  */
/*  valid stand-in as long as the mocked error text actually trips    */
/*  isRateLimitedError() (see that test above for the exact matcher).*/
/*  Picked maileroo specifically (not mailjet/mailgun/cloudflare):    */
/*  this file imports the cascade module ONCE at top scope (no        */
/*  vi.resetModules() per test, unlike email-cascade-available-quota  */
/*  .test.ts), so the in-memory quota counters are SHARED across every */
/*  describe block below. Driving a provider's quota to exhaustion    */
/*  here would leak into the "ambiguous delivery" describe (mailgun + */
/*  mailjet) or the "cloudflare provider" describe further down —     */
/*  maileroo is untouched by every other describe in this file.       */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade burst mitigation', () => {
  const realFetch = globalThis.fetch;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    process.env.MAILEROO_API_KEY = 'test-key';
    // Mock every network call. Maileroo statistics/summary lookup
    // (syncQuotasFromAPIs) → benign; send → 403 "reached the limit" (matches
    // isRateLimitedError's `reached...limit` pattern).
    globalThis.fetch = (async (url: string, opts?: any) => {
      calls.push(String(url));
      if (String(url).includes('smtp.maileroo.com/api/v2/emails')) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => '{"success":false,"message":"You have reached the limit of your monthly quota"}',
          json: async () => ({}),
        } as any;
      }
      // statistics/summary lookup during syncQuotasFromAPIs
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILEROO_API_KEY;
  });

  it('hits the Maileroo send endpoint only once for a 50-email batch', async () => {
    const emails = Array.from({ length: 50 }, (_, i) => ({
      payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' },
      recipient: { email: `r${i}@y.com` },
      meta: {},
    }));

    const { sent, failed } = await sendEmailCascade(emails, {
      forceProvider: 'maileroo',
      delayMs: 0,
    });

    const sendCalls = calls.filter(u => u.includes('smtp.maileroo.com/api/v2/emails')).length;
    // Before the fix (originally observed against mailtrap — see the "258
    // Mailtrap 403s in 5s" incident referenced in emailCascade.js): 50 burst
    // calls. After: provider marked exhausted on the first 403 →
    // remainingQuota 0 → every subsequent email is skipped locally.
    expect(sendCalls).toBe(1);
    expect(sent.length).toBe(0);
    expect(failed.length).toBe(50);
  });
});

/* ------------------------------------------------------------------ */
/*  Ambiguous delivery (#4911) — a provider accepting-then-failing on  */
/*  the response must not be retried on another provider (double-send) */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — ambiguous delivery does not double-send', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MAILGUN_API_KEY = 'mg-test-key';
    process.env.MAILGUN_DOMAIN = 'test.example.com';
    process.env.MAILJET_API_KEY = 'mj-key';
    process.env.MAILJET_SECRET_KEY = 'mj-secret';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
    delete process.env.MAILJET_API_KEY;
    delete process.env.MAILJET_SECRET_KEY;
  });

  it('does NOT fall back to the next provider when fetch() itself throws (transport-level, no HTTP response) — and flags the failure ambiguous', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('api.eu.mailgun.net') && String(url).includes('/messages')) {
        // Simulates a timeout/connection drop AFTER the request may already
        // have been accepted by Mailgun — no HTTP response was ever received.
        throw new TypeError('fetch failed');
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{ payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' }, recipient: { email: 'x@y.com' }, meta: {} }],
      { delayMs: 0 },
    );

    expect(sent.length).toBe(0);
    expect(failed.length).toBe(1);
    expect(failed[0].ambiguousDelivery).toBe(true);
    // Mailjet (the next provider in cascade order) must never be tried —
    // falling back here risks a second delivery if Mailgun actually
    // accepted the message before the response was lost.
    expect(calls.some(u => u.includes('api.mailjet.com'))).toBe(false);
  });

  it('still cascades to the next provider on an explicit HTTP rejection (not ambiguous, no regression)', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('api.eu.mailgun.net') && String(url).includes('/messages')) {
        return { ok: false, status: 500, text: async () => 'internal error', json: async () => ({}) } as any;
      }
      if (String(url).includes('api.mailjet.com')) {
        return {
          ok: true, status: 200,
          json: async () => ({ Messages: [{ Status: 'success', To: [{ MessageID: 'mj-1' }] }] }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{ payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' }, recipient: { email: 'x@y.com' }, meta: {} }],
      { delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(sent[0].provider).toBe('mailjet');
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

  it('strips the Feedback-ID header (CF rejects it with 10202) but keeps List-Unsubscribe', async () => {
    let sentHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes(CF_SEND)) {
        sentHeaders = JSON.parse(opts.body).headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { message_id: '<m@frontaliereticino.ch>' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent } = await sendEmailCascade(
      [{
        payload: {
          from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>',
          headers: {
            'List-Unsubscribe': '<https://x.ch/u>, <mailto:u@x.ch>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'Feedback-ID': 'camp:weekly:frontaliere-ticino',
          },
        },
        recipient: { email: 'x@y.com' }, meta: {},
      }],
      { forceProvider: 'cloudflare', delayMs: 0 },
    );

    expect(sent.length).toBe(1);
    expect(sentHeaders).toBeDefined();
    expect(sentHeaders!['Feedback-ID']).toBeUndefined();
    expect(sentHeaders!['List-Unsubscribe']).toBe('<https://x.ch/u>, <mailto:u@x.ch>');
    expect(sentHeaders!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
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

  it('cools down cloudflare after a code=10004 soft throttle without burning quota (no burst across a batch)', async () => {
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

    const quotaBefore = remainingQuota('cloudflare');
    const { sent, failed } = await sendEmailCascade(emails, { forceProvider: 'cloudflare', delayMs: 0 });

    const sendCalls = calls.filter(u => u.includes(CF_SEND)).length;
    expect(sendCalls).toBe(1); // 429 → provider cools down → rest skipped locally within the cooldown window
    expect(sent.length).toBe(0);
    expect(failed.length).toBe(10);
    // code=10004 is a burst throttle, not the daily cap being reached —
    // quota must stay exactly where it was before the batch.
    expect(remainingQuota('cloudflare')).toBe(quotaBefore);
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
