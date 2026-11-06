// @ts-nocheck
import {
  sendEmailCascade,
  providerSupportsScheduledSend,
  resolveScheduledAt,
  toRfc2822Utc,
  PROVIDERS,
} from '../scripts/lib/email-cascade.mjs';

/* ------------------------------------------------------------------ */
/*  providerSupportsScheduledSend — PROVIDERS.scheduledSend is the      */
/*  single source of truth (feature #3798)                             */
/* ------------------------------------------------------------------ */

describe('providerSupportsScheduledSend', () => {
  it('is true for resend, mailgun, maileroo', () => {
    expect(providerSupportsScheduledSend('resend')).toBe(true);
    expect(providerSupportsScheduledSend('mailgun')).toBe(true);
    expect(providerSupportsScheduledSend('maileroo')).toBe(true);
  });

  it('is false for mailjet, mailtrap, cloudflare (no scheduled-send API)', () => {
    expect(providerSupportsScheduledSend('mailjet')).toBe(false);
    expect(providerSupportsScheduledSend('mailtrap')).toBe(false);
    expect(providerSupportsScheduledSend('cloudflare')).toBe(false);
  });

  it('is false for an unknown provider id', () => {
    expect(providerSupportsScheduledSend('nonexistent')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  toRfc2822Utc — Mailgun o:deliverytime format, NOT toUTCString()     */
/* ------------------------------------------------------------------ */

describe('toRfc2822Utc', () => {
  it('formats a fixed UTC date as "Ddd, DD Mmm YYYY HH:MM:SS +0000"', () => {
    const d = new Date('2026-07-12T08:05:00.000Z');
    expect(toRfc2822Utc(d)).toBe('Sun, 12 Jul 2026 08:05:00 +0000');
  });

  it('uses an explicit numeric +0000 offset, never the "GMT" suffix toUTCString() emits', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const out = toRfc2822Utc(d);
    expect(out).not.toContain('GMT');
    expect(out.endsWith('+0000')).toBe(true);
  });

  it('zero-pads day/hour/minute/second', () => {
    const d = new Date('2026-03-05T03:07:09.000Z');
    expect(toRfc2822Utc(d)).toBe('Thu, 05 Mar 2026 03:07:09 +0000');
  });
});

/* ------------------------------------------------------------------ */
/*  resolveScheduledAt — direct unit coverage of the fallback matrix    */
/* ------------------------------------------------------------------ */

describe('resolveScheduledAt', () => {
  const resendProvider = PROVIDERS.find((p) => p.id === 'resend');
  const mailgunProvider = PROVIDERS.find((p) => p.id === 'mailgun');
  const mailjetProvider = PROVIDERS.find((p) => p.id === 'mailjet');

  it('resolves a valid near-future timestamp for a supporting provider', () => {
    const iso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const resolved = resolveScheduledAt({ scheduledAt: iso }, resendProvider);
    expect(resolved).toBeInstanceOf(Date);
    expect(resolved.toISOString()).toBe(iso);
  });

  it('returns null when scheduledAt is absent', () => {
    expect(resolveScheduledAt({}, resendProvider)).toBeNull();
  });

  it('returns null when scheduledAt is unparsable', () => {
    expect(resolveScheduledAt({ scheduledAt: 'not-a-date' }, resendProvider)).toBeNull();
  });

  it('returns null when scheduledAt is in the past', () => {
    const iso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(resolveScheduledAt({ scheduledAt: iso }, resendProvider)).toBeNull();
  });

  it('returns null when scheduledAt is under the 2-minute anti-race margin', () => {
    const iso = new Date(Date.now() + 30 * 1000).toISOString();
    expect(resolveScheduledAt({ scheduledAt: iso }, resendProvider)).toBeNull();
  });

  it('returns null when scheduledAt is beyond the provider max lookahead', () => {
    const iso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(); // +10d, mailgun cap is 3d
    expect(resolveScheduledAt({ scheduledAt: iso }, mailgunProvider)).toBeNull();
  });

  it('returns null when the provider has no scheduled-send support at all', () => {
    const iso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    expect(resolveScheduledAt({ scheduledAt: iso }, mailjetProvider)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  sendEmailCascade — resend: scheduled_at in the JSON body            */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — resend scheduled send', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => { process.env.RESEND_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  it('sends scheduled_at (ISO) in the POST body and surfaces scheduledFor on the result', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('api.resend.com/emails') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ id: 'resend-1' }), text: async () => '{}' } as any;
      }
      // fetchResendDailyUsage (GET, pagination) during syncQuotasFromAPIs
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'resend', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(sentBody.scheduled_at).toBe(scheduledAt);
    expect(sent[0].scheduledFor).toBe(scheduledAt);
  });

  it('omits scheduled_at entirely and returns scheduledFor:null when scheduledAt is in the past', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('api.resend.com/emails') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ id: 'resend-2' }), text: async () => '{}' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h in the past
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'resend', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sentBody).not.toHaveProperty('scheduled_at');
    expect(sent[0].scheduledFor).toBeNull();
  });

  it('sends an identical body (no scheduled_at key) when scheduledAt is absent — no regression', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('api.resend.com/emails') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ id: 'resend-3' }), text: async () => '{}' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>' },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'resend', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect('scheduled_at' in sentBody).toBe(false);
    expect(sent[0].scheduledFor).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  sendEmailCascade — mailgun: o:deliverytime in the multipart form    */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — mailgun scheduled send', () => {
  const realFetch = globalThis.fetch;
  const RFC2822_UTC_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/;

  beforeEach(() => {
    process.env.MAILGUN_API_KEY = 'test-key';
    process.env.MAILGUN_DOMAIN = 'frontaliereticino.ch';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
  });

  it('appends o:deliverytime in RFC 2822 UTC (explicit +0000, not toUTCString())', async () => {
    let deliverytime: string | null = 'unset';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('/messages') && opts?.method === 'POST') {
        deliverytime = opts.body.get('o:deliverytime');
        return { ok: true, status: 200, json: async () => ({ id: 'mg-1' }), text: async () => '{}' } as any;
      }
      // fetchMailgunDailyUsage stats lookup during syncQuotasFromAPIs
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'mailgun', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(deliverytime).toMatch(RFC2822_UTC_RE);
    expect(sent[0].scheduledFor).toBe(scheduledAt);
  });

  it('omits o:deliverytime and clamps to immediate send when beyond the 3-day lookahead (+10d)', async () => {
    let deliverytime: string | null = 'unset';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('/messages') && opts?.method === 'POST') {
        deliverytime = opts.body.get('o:deliverytime');
        return { ok: true, status: 200, json: async () => ({ id: 'mg-2' }), text: async () => '{}' } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'mailgun', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(deliverytime).toBeNull();
    expect(sent[0].scheduledFor).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  sendEmailCascade — maileroo: scheduled_at in the JSON body          */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — maileroo scheduled send', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MAILEROO_API_KEY = 'test-key';
    delete process.env.MAILEROO_TRANSACTIONAL_API_KEY;
    delete process.env.MAILEROO_NEWSLETTER_API_KEY;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILEROO_API_KEY;
    delete process.env.MAILEROO_TRANSACTIONAL_API_KEY;
    delete process.env.MAILEROO_NEWSLETTER_API_KEY;
  });

  it('sends scheduled_at (RFC 3339 / ISO) in the JSON body', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('smtp.maileroo.com') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ref-1' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'maileroo', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(sentBody.scheduled_at).toBe(scheduledAt);
    expect(sent[0].scheduledFor).toBe(scheduledAt);
  });

  it('sends Reply-To and attachments in Maileroo API shape', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('smtp.maileroo.com') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ref-attachment' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{
        payload: {
          from: 'Frontaliere <noreply@example.com>',
          to: ['candidate@example.com'],
          replyTo: 'HR <hr@example.com>',
          subject: 'Interview invitation',
          html: '<p>See attached.</p>',
          attachments: [{ filename: 'Invitation.pdf', contentType: 'application/pdf', content: 'JVBERi0x', inline: false }],
        },
        recipient: { email: 'candidate@example.com' },
        meta: {},
      }],
      { forceProvider: 'maileroo', delayMs: 0 },
    );

    expect(failed).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sentBody.reply_to).toEqual({ address: 'hr@example.com', display_name: 'HR' });
    expect(sentBody.attachments).toEqual([{
      file_name: 'Invitation.pdf',
      content_type: 'application/pdf',
      content: 'JVBERi0x',
      inline: false,
    }]);
  });

  it('sends CC, BCC and a valid reference id in Maileroo API shape', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('smtp.maileroo.com') && opts?.method === 'POST') {
        sentBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ref-cc-bcc' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade(
      [{
        payload: {
          from: 'Frontaliere <noreply@example.com>',
          to: ['candidate@example.com'],
          cc: ['HR <hr@example.com>'],
          bcc: [{ address: 'audit@example.com', display_name: 'Audit' }],
          referenceId: '0123456789abcdef01234567',
          subject: 'Interview invitation',
          html: '<p>See you soon.</p>',
        },
        recipient: { email: 'candidate@example.com' },
        meta: {},
      }],
      { forceProvider: 'maileroo', delayMs: 0 },
    );

    expect(failed).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sentBody.cc).toEqual([{ address: 'hr@example.com', display_name: 'HR' }]);
    expect(sentBody.bcc).toEqual([{ address: 'audit@example.com', display_name: 'Audit' }]);
    expect(sentBody.reference_id).toBe('0123456789abcdef01234567');
  });

  it('routes newsletter and transactional senders to their separate Application keys', async () => {
    const sentHeaders: string[] = [];
    process.env.MAILEROO_TRANSACTIONAL_API_KEY = 'transactional-key';
    process.env.MAILEROO_NEWSLETTER_API_KEY = 'newsletter-key';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('smtp.maileroo.com') && opts?.method === 'POST') {
        sentHeaders.push(opts.headers['X-Api-Key']);
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ref-routing' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { sent, failed } = await sendEmailCascade([
      {
        payload: {
          from: 'Frontaliere Ticino <newsletter@frontaliereticino.ch>',
          to: ['subscriber@example.com'],
          subject: 'Weekly newsletter',
          html: '<p>News</p>',
        },
        recipient: { email: 'subscriber@example.com' },
        meta: {},
      },
      {
        payload: {
          from: 'Frontaliere Ticino <confirmation@frontaliereticino.ch>',
          to: ['customer@example.com'],
          subject: 'Confirmation',
          html: '<p>Confirmed</p>',
        },
        recipient: { email: 'customer@example.com' },
        meta: {},
      },
    ], { forceProvider: 'maileroo', delayMs: 0 });

    expect(failed).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sentHeaders).toEqual(['newsletter-key', 'transactional-key']);
  });

  it('allows an explicit stream for a newly allowlisted sender', async () => {
    let sentKey = '';
    process.env.MAILEROO_TRANSACTIONAL_API_KEY = 'transactional-key';
    process.env.MAILEROO_NEWSLETTER_API_KEY = 'newsletter-key';
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('smtp.maileroo.com') && opts?.method === 'POST') {
        sentKey = opts.headers['X-Api-Key'];
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { reference_id: 'maileroo-ref-explicit-stream' } }),
          text: async () => '{}',
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const { failed } = await sendEmailCascade([{
      payload: {
        from: 'Frontaliere Ticino <campaign@frontaliereticino.ch>',
        mailerooStream: 'newsletter',
        to: ['subscriber@example.com'],
        subject: 'Campaign',
        html: '<p>Campaign</p>',
      },
      recipient: { email: 'subscriber@example.com' },
      meta: {},
    }], { forceProvider: 'maileroo', delayMs: 0 });

    expect(failed).toHaveLength(0);
    expect(sentKey).toBe('newsletter-key');
  });
});

/* ------------------------------------------------------------------ */
/*  sendEmailCascade — mailjet: no scheduled-send support at all        */
/* ------------------------------------------------------------------ */

describe('sendEmailCascade — mailjet has no scheduled-send support', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MAILJET_API_KEY = 'test-key';
    process.env.MAILJET_SECRET_KEY = 'test-secret';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILJET_API_KEY;
    delete process.env.MAILJET_SECRET_KEY;
  });

  it('sends the payload with no scheduling fields; scheduledFor is null even with scheduledAt set', async () => {
    let sentBody: any = null;
    globalThis.fetch = (async (url: string, opts?: any) => {
      if (String(url).includes('api.mailjet.com/v3.1/send')) {
        sentBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          json: async () => ({ Messages: [{ To: [{ MessageID: 'mj-1' }] }] }),
          text: async () => '{}',
        } as any;
      }
      // fetchMailjetDailyUsage stats lookup during syncQuotasFromAPIs
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as any;
    }) as any;

    const scheduledAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', scheduledAt },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'mailjet', delayMs: 0 },
    );

    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    expect(JSON.stringify(sentBody).toLowerCase()).not.toContain('scheduled');
    expect(sent[0].scheduledFor).toBeNull();
  });
});
