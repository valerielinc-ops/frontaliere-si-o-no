// @ts-nocheck
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEND_URL = 'https://smtp.maileroo.com/api/v2/emails';

function email() {
  return {
    payload: {
      from: 'Frontaliere <newsletter@frontaliereticino.ch>',
      to: ['reader@example.com'],
      subject: 'Newsletter',
      html: '<p>Newsletter</p>',
    },
    recipient: { email: 'reader@example.com' },
    meta: {},
  };
}

describe('sendEmailCascade adaptive throttle', () => {
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

  it('parte da 100ms e sale di 100ms sui 429 fino al primo successo', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        if (attempts <= 3) {
          return {
            ok: false,
            status: 429,
            text: async () => 'Too Many Requests',
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ok' } }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const pending = sendEmailCascade([email()], {
      forceProvider: 'maileroo',
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(attempts).toBe(4);
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.adaptiveThrottle).toEqual({
      initialDelayMs: 100,
      maxDelayMs: 1000,
      stepMs: 100,
      providers: { maileroo: { delayMs: 400, escalations: 3 } },
    });
  });

  it('non supera 1s e poi applica il comportamento di exhaustion esistente', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        return { ok: false, status: 429, text: async () => 'Too Many Requests' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const pending = sendEmailCascade([email()], {
      forceProvider: 'maileroo',
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(attempts).toBe(10);
    expect(result.sent).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.adaptiveThrottle.providers.maileroo).toEqual({ delayMs: 1000, escalations: 9 });
  });

  it('mantiene invariato il comportamento predefinito senza opt-in', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        return { ok: false, status: 429, text: async () => 'Too Many Requests' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const result = await sendEmailCascade([email()], {
      forceProvider: 'maileroo',
      delayMs: 0,
    });

    expect(attempts).toBe(1);
    expect(result).not.toHaveProperty('adaptiveThrottle');
  });

  it('legge lo status HTTP, non numeri casuali nel body di un 403', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        return { ok: false, status: 403, text: async () => 'Monthly limit is 500 messages' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const result = await sendEmailCascade([email()], {
      forceProvider: 'maileroo',
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
    });

    expect(attempts).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.adaptiveThrottle.providers.maileroo).toEqual({ delayMs: 100, escalations: 0 });
  });

  it('non ritenta mai una consegna ambigua anche con adaptive throttle attivo', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === SEND_URL) {
        attempts += 1;
        throw new Error('network timeout');
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    });

    const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
    const result = await sendEmailCascade([email()], {
      forceProvider: 'maileroo',
      delayMs: 100,
      adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 },
    });

    expect(attempts).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ambiguousDelivery).toBe(true);
    expect(result.adaptiveThrottle.providers.maileroo).toEqual({ delayMs: 100, escalations: 0 });
  });

  it('e cablato nella newsletter con base 100ms, step 100ms e tetto 1s', () => {
    const script = fs.readFileSync(new URL('../scripts/send-newsletter.mjs', import.meta.url), 'utf8');

    expect(script).toMatch(/NEWSLETTER_SEND_THROTTLE\s*=\s*Object\.freeze\(\{\s*delayMs:\s*100,/s);
    expect(script).toMatch(/adaptiveThrottle:\s*Object\.freeze\(\{\s*stepMs:\s*100,\s*maxDelayMs:\s*1000\s*\}\)/s);
    expect(script.match(/\.\.\.NEWSLETTER_SEND_THROTTLE/g)).toHaveLength(2);
  });
});
