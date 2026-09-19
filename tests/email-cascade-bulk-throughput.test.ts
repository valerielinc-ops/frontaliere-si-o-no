// @ts-nocheck
// Throughput of the bulk senders (job alerts, newsletter) and the invariants
// that make running them with several workers safe. Measured baseline:
// job-alert run 35422626497 = 1.0 email/s (per-provider 1000ms spacing was the
// ceiling), newsletter run 35075707530 = 0.97 email/s (concurrency 1).
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEND_URL = 'https://smtp.maileroo.com/api/v2/emails';

function email(n = 0) {
  const to = `reader${n}@example.com`;
  return {
    payload: {
      from: 'Frontaliere <newsletter@frontaliereticino.ch>',
      to: [to],
      subject: 'Newsletter',
      html: '<p>Newsletter</p>',
    },
    recipient: { email: to },
    meta: {},
  };
}

const okSend = (id: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { reference_id: id } }),
});
const otherCall = { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };

describe('isQuotaExhaustedError', () => {
  it('riconosce la quota giornaliera/mensile esaurita, non il burst transitorio', async () => {
    const { isQuotaExhaustedError } = await import('../functions/src/emailCascade.js');
    expect(isQuotaExhaustedError('Mailgun 429: {"message":"daily request limit (100) exceeded"}')).toBe(true);
    expect(isQuotaExhaustedError('Resend 429: {"name":"daily_quota_exceeded","message":"You have reached your daily email sending quota."}')).toBe(true);
    expect(isQuotaExhaustedError('Mailjet 429: monthly quota exhausted')).toBe(true);
    expect(isQuotaExhaustedError('Maileroo 429: Too Many Requests')).toBe(false);
    expect(isQuotaExhaustedError('Resend 429: {"name":"rate_limit_exceeded","message":"Too many requests. You can only make 2 requests per second."}')).toBe(false);
    expect(isQuotaExhaustedError('Maileroo 403: Monthly limit is 500 messages')).toBe(false);
    expect(isQuotaExhaustedError('')).toBe(false);
  });
});

describe('sendEmailCascade bulk throughput', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.MAILEROO_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    delete process.env.MAILEROO_API_KEY;
  });

  it('un 429 da quota giornaliera esaurita ritira subito il provider, senza scalino adattivo', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        return { ok: false, status: 429, text: async () => '{"message":"daily request limit (100) exceeded"}' } as any;
      }
      return otherCall as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const pending = sendEmailCascade([email(1), email(2), email(3)], {
      forceProvider: 'maileroo',
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    // One request total: the first reply retires the provider, the next two
    // emails are not even attempted against it.
    expect(attempts).toBe(1);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.every((f) => !f.ambiguousDelivery)).toBe(true);
    expect(result.adaptiveThrottle.providers.maileroo).toEqual({ delayMs: 100, escalations: 0 });
  });

  it('con 4 worker e spaziatura 100ms la latenza del provider si sovrappone, ogni email parte una volta sola', async () => {
    const startedAt: number[] = [];
    const recipients: string[] = [];
    const t0 = Date.now();
    globalThis.fetch = vi.fn(async (url: string, opts: any) => {
      if (url === SEND_URL) {
        startedAt.push(Date.now() - t0);
        recipients.push(JSON.parse(opts.body).to?.[0]?.address ?? JSON.parse(opts.body).to);
        await new Promise((r) => setTimeout(r, 900)); // measured maileroo round-trip
        return okSend(`id-${startedAt.length}`) as any;
      }
      return otherCall as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const items = Array.from({ length: 8 }, (_, i) => email(i));
    const onSentCalls: string[] = [];
    const pending = sendEmailCascade(items, {
      forceProvider: 'maileroo',
      concurrency: 4,
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
      onSent: async (item) => { onSentCalls.push(item.recipient.email); },
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    const elapsed = Date.now() - t0;

    expect(result.sent).toHaveLength(8);
    expect(result.failed).toHaveLength(0);
    // No double send: each recipient reached the provider and onSent exactly once.
    expect(new Set(onSentCalls).size).toBe(8);
    expect(onSentCalls).toHaveLength(8);
    expect(startedAt).toHaveLength(8);
    expect(new Set(recipients).size).toBe(8);
    // Per-provider spacing still holds between consecutive requests...
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(100);
    }
    // ...but is no longer the ceiling: 8 sends take ~2 round-trips, not 8 s.
    expect(8 / (elapsed / 1000)).toBeGreaterThanOrEqual(2.5);
  });

  it('il floor per provider tiene la spaziatura anche con delay basso e piu worker', async () => {
    const startedAt: number[] = [];
    const t0 = Date.now();
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        startedAt.push(Date.now() - t0);
        return okSend(`id-${startedAt.length}`) as any;
      }
      return otherCall as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const pending = sendEmailCascade([email(1), email(2), email(3), email(4)], {
      forceProvider: 'maileroo',
      concurrency: 4,
      delayMs: 100,
      providerMinIntervalMs: { maileroo: 1000 },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.sent).toHaveLength(4);
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });

  it('i floor bulk coprono i provider con limiti di burst noti', async () => {
    const { BULK_PROVIDER_MIN_INTERVAL_MS } = await import('../functions/src/emailCascade.js');
    expect(BULK_PROVIDER_MIN_INTERVAL_MS.cloudflare).toBeGreaterThanOrEqual(1000);
    expect(BULK_PROVIDER_MIN_INTERVAL_MS.resend).toBeGreaterThanOrEqual(500);
    expect(Object.isFrozen(BULK_PROVIDER_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('wiring dei sender bulk', () => {
  it('job alert: spaziatura 100ms, adaptive fino a 1s, 4 worker, floor per provider su entrambe le chiamate', () => {
    const script = fs.readFileSync(new URL('../scripts/send-job-alerts.mjs', import.meta.url), 'utf8');
    expect(script).toMatch(/JOB_ALERT_SEND_THROTTLE\s*=\s*Object\.freeze\(\{\s*concurrency:\s*4,\s*delayMs:\s*100,\s*adaptiveThrottle:\s*Object\.freeze\(\{\s*stepMs:\s*100,\s*maxDelayMs:\s*1000\s*\}\)/s);
    expect(script.match(/\.\.\.JOB_ALERT_SEND_THROTTLE/g)).toHaveLength(2);
    expect(script.match(/providerMinIntervalMs:\s*BULK_PROVIDER_MIN_INTERVAL_MS/g)).toHaveLength(2);
    expect(script).not.toMatch(/sendEmailCascade\([^)]*\{\s*concurrency:\s*3,\s*onSent/s);
  });

  it('newsletter: 4 worker nominati e floor per provider su entrambe le chiamate', () => {
    const script = fs.readFileSync(new URL('../scripts/send-newsletter.mjs', import.meta.url), 'utf8');
    expect(script).toMatch(/const NEWSLETTER_SEND_CONCURRENCY = 4;/);
    expect(script.match(/concurrency:\s*NEWSLETTER_SEND_CONCURRENCY/g)).toHaveLength(2);
    expect(script.match(/providerMinIntervalMs:\s*BULK_PROVIDER_MIN_INTERVAL_MS/g)).toHaveLength(2);
  });
});
