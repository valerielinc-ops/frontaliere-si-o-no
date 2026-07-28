import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
// @ts-expect-error — Cloudflare Worker module, no types
import worker, { isStopReply, isAutoReply, extractSenderEmail, hmacHex } from '../infra/cloudflare-email-worker/stop-reply-handler.js';

// The worker binds TWO Email Routing addresses to the same script
// (scripts/cf-email-worker-setup.mjs's ROUTING_RULES) and branches on
// `message.to`: NEWSLETTER_ADDRESS → auto-unsubscribe via the one-click Cloud
// Function, anything else → the existing cold-email outreach STOP path. Both
// must keep forwarding to the human inbox unconditionally.

const SECRET = 'shared-test-secret';

function fakeMessage({ from, to, subject, rawText = '', headers = {} }: { from: string; to: string; subject: string; rawText?: string; headers?: Record<string, string> }) {
  const bytes = new TextEncoder().encode(rawText);
  const headerMap = new Map(Object.entries({ subject, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    from,
    to,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) },
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

describe('isAutoReply', () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] });

  it('detects RFC 3834 Auto-Submitted values other than "no"', () => {
    expect(isAutoReply(headers({ 'auto-submitted': 'auto-replied' }))).toBe(true);
    expect(isAutoReply(headers({ 'auto-submitted': 'auto-generated' }))).toBe(true);
    expect(isAutoReply(headers({ 'auto-submitted': 'no' }))).toBe(false);
  });

  it('detects the de-facto vendor autoresponder headers', () => {
    expect(isAutoReply(headers({ 'x-autoreply': 'yes' }))).toBe(true);
    expect(isAutoReply(headers({ 'x-autorespond': 'vacation' }))).toBe(true);
    expect(isAutoReply(headers({ precedence: 'auto_reply' }))).toBe(true);
  });

  it('treats Precedence: bulk as automated ONLY with a second signal', () => {
    // Plenty of human-sent list mail carries Precedence: bulk — on its own it
    // must not cost us the message.
    expect(isAutoReply(headers({ precedence: 'bulk' }))).toBe(false);
    expect(isAutoReply(headers({ precedence: 'bulk', 'x-auto-response-suppress': 'All' }))).toBe(true);
  });

  it('falls back to out-of-office subject shapes when the headers are absent', () => {
    // The subject of the real incident (a vacation responder answering a job
    // alert), plus the other forms autoresponders use.
    expect(isAutoReply(headers({}), 'Out of office Re: 🔔 MaP Executive Director at ETH Zürich (+9 more)')).toBe(true);
    expect(isAutoReply(headers({}), 'Automatic reply: Frontaliere Weekly')).toBe(true);
    expect(isAutoReply(headers({}), 'Risposta automatica: offerte della settimana')).toBe(true);
    expect(isAutoReply(headers({}), 'Re: Automatische Antwort')).toBe(true);
    expect(isAutoReply(headers({}), 'Re: your email [Out of Office]')).toBe(true);
  });

  it('does not drop human mail that merely mentions the phrase', () => {
    expect(isAutoReply(headers({}), 'Re: our out of office policy for August')).toBe(false);
    expect(isAutoReply(headers({}), 'Re: 🔔 MaP Executive Director at ETH Zürich')).toBe(false);
    expect(isAutoReply(headers({}), '')).toBe(false);
  });

  it('survives a missing/throwing headers object', () => {
    expect(isAutoReply(undefined, 'hello')).toBe(false);
    expect(isAutoReply({ get: () => { throw new Error('boom'); } }, 'hello')).toBe(false);
  });
});

describe('worker email() — automatic responses', () => {
  it('drops an out-of-office reply: no tracking, no suppression, no forward', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    // Reproduces the incident headers verbatim: a Gmail vacation responder
    // answering a job-alert send, landing on the abuse@ role address.
    const message = fakeMessage({
      from: '"Away Recipient" <away@example.com>',
      to: 'abuse@frontaliereticino.ch',
      subject: 'Out of office Re: 🔔 MaP Executive Director at ETH Zürich (+9 more)',
      rawText: 'Thanks for your email. I am currently out of office.',
      headers: { precedence: 'bulk', 'x-autoreply': 'yes', 'auto-submitted': 'auto-replied' },
    });
    const ctx = fakeCtx();

    await worker.email(message, {
      STOP_SECRET: SECRET,
      REPLY_TRACK_FN_URL: 'https://fn.example/track',
      STOP_REPLY_FN_URL: 'https://fn.example/stop',
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      OUTREACH_ADDRESS: 'valerie@frontaliereticino.ch',
      FORWARD_TO: 'human@example.com',
    }, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.forward).not.toHaveBeenCalled();
  });

  it('never unsubscribes a real subscriber from an auto-reply body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    // A corporate out-of-office footer routinely carries the word
    // "unsubscribe" — without the auto-reply gate this wrote a real Firestore
    // unsubscribe for someone who never asked.
    const message = fakeMessage({
      from: 'Jane Reader <jane.reader@example.com>',
      to: 'newsletter@frontaliereticino.ch',
      subject: 'Automatic reply: Frontaliere Weekly',
      rawText: 'I am on leave until August. To unsubscribe from our own updates, click here.',
      headers: { 'auto-submitted': 'auto-replied' },
    });
    const ctx = fakeCtx();

    await worker.email(message, {
      STOP_SECRET: SECRET,
      NEWSLETTER_UNSUB_URL: 'https://frontaliereticino.ch/disiscrivi-newsletter/',
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      OUTREACH_ADDRESS: 'valerie@frontaliereticino.ch',
      FORWARD_TO: 'human@example.com',
    }, ctx);

    await Promise.all(ctx.waited);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.forward).not.toHaveBeenCalled();
  });
});

describe('worker email() — forward-only addresses', () => {
  it('forwards a human message to a bound role address without outreach tracking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'Someone <someone@example.com>',
      to: 'alerts@frontaliereticino.ch',
      subject: 'question about a job alert',
      rawText: 'Hi, can you stop sending these on weekends?',
    });
    const ctx = fakeCtx();

    await worker.email(message, {
      STOP_SECRET: SECRET,
      REPLY_TRACK_FN_URL: 'https://fn.example/track',
      STOP_REPLY_FN_URL: 'https://fn.example/stop',
      NEWSLETTER_ADDRESS: 'newsletter@frontaliereticino.ch',
      OUTREACH_ADDRESS: 'valerie@frontaliereticino.ch',
      FORWARD_TO: 'human@example.com',
    }, ctx);

    await Promise.all(ctx.waited);
    // alerts@ is not the outreach mailbox: the message must reach the human
    // inbox, but it is not a company reply and must not be recorded as one —
    // note the body would otherwise match the loose \bstop\b intent.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledWith('human@example.com');
  });
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

  it('still routes to the newsletter path when `to` is display-name-wrapped (defensive, #4369)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'Jane Reader <jane.reader@example.com>',
      to: '"Frontaliere Newsletter" <newsletter@frontaliereticino.ch>',
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
    expect(calledUrl.searchParams.get('email')).toBe('jane.reader@example.com');
    expect(message.forward).toHaveBeenCalledWith('ops@example.com');
  });

  it('does NOT unsubscribe on a loose conversational STOP form (newsletter path is stricter than outreach)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const message = fakeMessage({
      from: 'reader@example.com',
      to: 'newsletter@frontaliereticino.ch',
      subject: 'Question',
      rawText: 'Will this promo stop working next month? Also please remove me from the CC list on future threads, not the newsletter.',
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

    // "stop" and "remove me" alone are outreach-path intent tokens (see
    // STOP_INTENT_PATTERNS) but are NOT in NEWSLETTER_STOP_INTENT_PATTERNS —
    // a real subscriber's ordinary reply must never trigger an unsubscribe.
    expect(fetchMock).not.toHaveBeenCalled();
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
