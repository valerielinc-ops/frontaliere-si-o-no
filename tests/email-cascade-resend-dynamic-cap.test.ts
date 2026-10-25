// @ts-nocheck
import {
  resendCycleBounds,
  computeResendDynamicDailyLimit,
  computeMailerooDynamicDailyLimit,
  fetchMailerooCycleUsage,
  fetchResendCycleUsage,
  PROVIDERS,
  sendEmailCascade,
} from '../scripts/lib/email-cascade.mjs';

/* ------------------------------------------------------------------ */
/*  resendCycleBounds — pure, quota cycle anchored on the 6th          */
/* ------------------------------------------------------------------ */

describe('resendCycleBounds', () => {
  it('resolves the current cycle when nowMs is after the anchor day', () => {
    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const { cycleStart, cycleEnd } = resendCycleBounds(nowMs);
    expect(cycleStart.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(cycleEnd.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });

  it('resolves the previous month as cycle start when nowMs is before the anchor day', () => {
    const nowMs = new Date('2026-07-03T12:00:00.000Z').getTime();
    const { cycleStart, cycleEnd } = resendCycleBounds(nowMs);
    expect(cycleStart.toISOString()).toBe('2026-06-06T00:00:00.000Z');
    expect(cycleEnd.toISOString()).toBe('2026-07-06T00:00:00.000Z');
  });

  it('rolls over the year when nowMs is in January before the anchor day', () => {
    const nowMs = new Date('2026-01-03T12:00:00.000Z').getTime();
    const { cycleStart, cycleEnd } = resendCycleBounds(nowMs);
    expect(cycleStart.toISOString()).toBe('2025-12-06T00:00:00.000Z');
    expect(cycleEnd.toISOString()).toBe('2026-01-06T00:00:00.000Z');
  });

  it('treats the anchor day itself as the start of the new cycle', () => {
    const nowMs = new Date('2026-07-06T00:00:01.000Z').getTime();
    const { cycleStart, cycleEnd } = resendCycleBounds(nowMs);
    expect(cycleStart.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(cycleEnd.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });
});

/* ------------------------------------------------------------------ */
/*  fetchResendCycleUsage / computeResendDynamicDailyLimit             */
/* ------------------------------------------------------------------ */

function entry(id, isoDate) {
  return { id, created_at: `${isoDate}T10:00:00.000Z` };
}

describe('fetchResendCycleUsage', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => { process.env.RESEND_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  it('counts entries within the current cycle and stops at the cycle boundary', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const entries = [
        entry('c1', '2026-07-16'),
        entry('c2', '2026-07-10'),
        entry('c3', '2026-07-06'), // still inside cycle (cycleStart is inclusive)
        entry('c4', '2026-07-05'), // before cycle anchor -> stop here
        entry('c5', '2026-06-20'),
      ];
      return { ok: true, status: 200, json: async () => ({ data: entries, has_more: true }) };
    }) as any;

    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const { count, truncated, cycleStart, cycleEnd } = await fetchResendCycleUsage(nowMs);
    expect(count).toBe(3);
    expect(truncated).toBe(false);
    expect(calls).toBe(1);
    expect(cycleStart.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(cycleEnd.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });

  it('reports truncated:true when a page request fails mid-pagination', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const { truncated } = await fetchResendCycleUsage(nowMs);
    expect(truncated).toBe(true);
  });

  it('returns count:0, truncated:false when no API key is configured', async () => {
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = (async () => { throw new Error('should not be called'); }) as any;
    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const { count, truncated } = await fetchResendCycleUsage(nowMs);
    expect(count).toBe(0);
    expect(truncated).toBe(false);
  });
});

describe('computeResendDynamicDailyLimit', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => { process.env.RESEND_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  it('uses the free-plan limits and never exceeds 100/day', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [entry('c1', '2026-07-16')], has_more: false }),
    })) as any;

    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const limit = await computeResendDynamicDailyLimit(nowMs);
    const resend = PROVIDERS.find(p => p.id === 'resend');
    expect(resend).toMatchObject({ dailyLimit: 100, monthlyLimit: 3000 });
    expect(limit).toBe(100);
  });

  it('falls back to the 100/day ceiling when cycle usage is unverifiable', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const limit = await computeResendDynamicDailyLimit(nowMs);
    expect(limit).toBe(100);
  });

  it('reduces the daily limit further when needed to stay within 3000/month', async () => {
    const heavyUsage = Array.from({ length: 2958 }, (_, i) => entry(`c${i}`, '2026-07-16'));
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: heavyUsage, has_more: false }),
    })) as any;
    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const limit = await computeResendDynamicDailyLimit(nowMs);
    expect(limit).toBe(2);
  });
});

describe('computeMailerooDynamicDailyLimit', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => { process.env.MAILEROO_ACCOUNT_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILEROO_ACCOUNT_API_KEY;
  });

  it('uses the 250k plan and its safe 31-day fallback', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;

    const limit = await computeMailerooDynamicDailyLimit(new Date('2026-07-16T12:00:00.000Z').getTime());
    const maileroo = PROVIDERS.find(p => p.id === 'maileroo');
    expect(maileroo).toMatchObject({ dailyLimit: 8064, monthlyLimit: 250000 });
    expect(limit).toBe(8064);
  });

  it('reads the live plan, exact usage and cycle reset from the Account API', async () => {
    globalThis.fetch = (async (url) => {
      expect(String(url)).toContain('/v1/account');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            current_plan: { id: 6, name: 'Pro', quantity: 250000 },
            usage: [
              { name: 'Hourly Outbound Usage', quantity: 10000, used: 4, available: 9996 },
              { name: 'Monthly Outbound Usage', quantity: 250000, used: 100000, available: 150000 },
            ],
            subscription: {
              current_period_start: '2026-07-01T00:00:00.000Z',
              current_period_end: '2026-08-01T00:00:00.000Z',
            },
          },
        }),
      };
    }) as any;

    const usage = await fetchMailerooCycleUsage(new Date('2026-07-16T12:00:00.000Z').getTime());
    expect(usage).toMatchObject({
      count: 100000,
      monthlyLimit: 250000,
      hourlyAvailable: 9996,
      verified: true,
      source: 'account',
    });
    expect(usage.billingPeriodEndMs).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
  });

  it('paces verified Account API usage against the 250k billing-cycle budget', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          usage: [
            { name: 'Hourly Outbound Usage', quantity: 10000, used: 4, available: 9996 },
            { name: 'Monthly Outbound Usage', quantity: 250000, used: 100000, available: 150000 },
          ],
          subscription: {
            current_period_start: '2026-07-01T00:00:00.000Z',
            current_period_end: '2026-08-01T00:00:00.000Z',
          },
        },
      }),
    })) as any;

    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const limit = await computeMailerooDynamicDailyLimit(nowMs);
    // 150000 remaining over the 16 billing-cycle days left from noon on July
    // 16: the verified pace may exceed the conservative 31-day fallback.
    expect(limit).toBe(9375);
  });

  it('uses the live Account API monthly plan quantity and outbound usage', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('https://api.maileroo.com/v1/account');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            current_plan: { quantity: 180000 },
            usage: [{ name: 'Monthly Outbound Usage', quantity: 180000, used: 100000 }],
            subscription: {
              current_period_start: '2026-07-01T00:00:00.000Z',
              current_period_end: '2026-08-01T00:00:00.000Z',
            },
          },
        }),
      } as any;
    }) as any;

    const nowMs = new Date('2026-07-16T12:00:00.000Z').getTime();
    const limit = await computeMailerooDynamicDailyLimit(nowMs);
    // 80000 remaining over the 16 calendar days left in the billing period
    // from noon on July 16.
    expect(limit).toBe(5000);
  });
});

describe('Resend free-plan send cap', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.EMAIL_LINK_AUDIT = 'off';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_LINK_AUDIT;
  });

  it('sends at most 100 messages even with concurrent workers', async () => {
    let posts = 0;
    globalThis.fetch = (async (url, opts: any = {}) => {
      if (String(url).includes('api.resend.com/emails') && opts.method === 'POST') {
        posts++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ok: true, status: 200, json: async () => ({ id: `resend-${posts}` }), text: async () => '{}' } as any;
      }
      if (String(url).includes('api.resend.com/emails')) {
        return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any;

    const emails = Array.from({ length: 101 }, (_, i) => ({
      payload: { from: 'sender@example.com', to: [`user-${i}@example.com`], subject: 'test', html: '<p>test</p>' },
      recipient: { email: `user-${i}@example.com` },
      meta: {},
    }));
    const result = await sendEmailCascade(emails, { forceProvider: 'resend', concurrency: 3, delayMs: 0 });

    expect(posts).toBe(100);
    expect(result.sent).toHaveLength(100);
    expect(result.failed).toHaveLength(1);
  });
});
