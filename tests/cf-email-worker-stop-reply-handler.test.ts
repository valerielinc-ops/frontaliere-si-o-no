import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
// @ts-expect-error — Cloudflare Worker module, no types
import worker, { isStopReply, extractSenderEmail, hmacHex } from '../infra/cloudflare-email-worker/stop-reply-handler.js';

// The worker binds TWO Email Routing addresses to the same script
// (scripts/cf-email-worker-setup.mjs's ROUTING_RULES) and branches on
// `message.to`: NEWSLETTER_ADDRESS → auto-unsubscribe via the one-click Cloud
// Function, anything else → the existing cold-email outreach STOP path. Both
// must keep forwarding to the human inbox unconditionally.

const SECRET = 'shared-test-secret';

function fakeMessage({ from, to, subject, rawText = '' }: { from: string; to: string; subject: string; rawText?: string }) {
  const bytes = new TextEncoder().encode(rawText);
  return {
    from,
    to,
    headers: { get: (name: string) => (name.toLowerCase() === 'subject' ? subject : undefined) },
    raw: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          releaseLock() {},
        };
      },
    },
    forward: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeCtx() {
  const waited: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, waited };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hmacHex (Web Crypto)', () => {
  it('matches Node createHmac(sha256).digest(hex) byte-for-byte', async () => {
    const expected = createHmac('sha256', SECRET).update('someone@example.com').digest('hex');
    expect(await hmacHex(SECRET, 'someone@example.com')).toBe(expected);
  });
});

describe('worker email() — newsletter mailbox branch', () => {
  it('signs the sender email and calls the one-click unsubscribe endpoint, then forwards', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'Jane Reader <jane.reader@example.com>',
      to: 'newsletter@frontaliereticino.ch',
      subject: 'Unsubscribe Frontaliere Weekly',
      rawText: 'Please unsubscribe jane.reader@example.com from Frontaliere Weekly.',
    });
    const ctx = fakeCtx();
    const env = {
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      NEWSLETTER_UNSUB_URL: 'https://frontaliereticino.ch/disiscrivi-newsletter/',
      STOP_SECRET: SECRET,
      FORWARD_TO: 'ops@example.com',
    };

    await worker.email(message, env, ctx);
    await Promise.all(ctx.waited);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://frontaliereticino.ch/disiscrivi-newsletter/');
    expect(calledUrl.searchParams.get('action')).toBe('unsubscribe');
    expect(calledUrl.searchParams.get('email')).toBe('jane.reader@example.com');
    expect(calledUrl.searchParams.get('token')).toBe(
      createHmac('sha256', SECRET).update('jane.reader@example.com').digest('hex'),
    );
    expect(message.forward).toHaveBeenCalledWith('ops@example.com');
  });

  it('never calls the unsubscribe endpoint when the reply has no STOP intent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'reader@example.com',
      to: 'newsletter@frontaliereticino.ch',
      subject: 'Question about last week issue',
      rawText: 'Hey, loved the article on cross-border commuters, any plans to cover Basel?',
    });
    const ctx = fakeCtx();
    const env = {
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      NEWSLETTER_UNSUB_URL: 'https://frontaliereticino.ch/disiscrivi-newsletter/',
      STOP_SECRET: SECRET,
      FORWARD_TO: 'ops@example.com',
    };

    await worker.email(message, env, ctx);
    await Promise.all(ctx.waited);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledWith('ops@example.com');
  });

  it('does not route the outreach reply address into the newsletter path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'hr@aldi.ch',
      to: 'valerie@frontaliereticino.ch',
      subject: 'STOP',
      rawText: '',
    });
    const ctx = fakeCtx();
    const env = {
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      NEWSLETTER_UNSUB_URL: 'https://frontaliereticino.ch/disiscrivi-newsletter/',
      STOP_REPLY_FN_URL: 'https://example.test/outreachStopReply',
      REPLY_TRACK_FN_URL: 'https://example.test/outreachReplyTrack',
      STOP_SECRET: SECRET,
      FORWARD_TO: 'ops@example.com',
    };

    await worker.email(message, env, ctx);
    await Promise.all(ctx.waited);

    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calledUrls.some((u: string) => u.startsWith('https://example.test/'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('disiscrivi-newsletter'))).toBe(false);
    expect(message.forward).toHaveBeenCalledWith('ops@example.com');
  });
});

describe('isStopReply / extractSenderEmail (worker-local mirror)', () => {
  it('matches the same intent forms as the shared lib', () => {
    expect(isStopReply('Unsubscribe Frontaliere Weekly', '')).toBe(true);
    expect(isStopReply('', 'Please unsubscribe me from this list.')).toBe(true);
    expect(isStopReply('Re: last newsletter', 'loved this week issue')).toBe(false);
  });

  it('extracts a bare address from a display-name From header', () => {
    expect(extractSenderEmail('Jane Reader <jane.reader@example.com>')).toBe('jane.reader@example.com');
  });
});
