import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmailCascade } from '../functions/src/emailCascade.js';
import { ASSISTED_EMAIL_PROVIDERS, replyThreadMessageId } from '../functions/src/assistedApplicationEmployerMail.js';
import { APPLY_RE } from '../scripts/assisted-application/lib/portal/portal.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('application transport contracts', () => {
  it('satisfies the Maileroo reserved-header contract and preserves the rest of the application', async () => {
    vi.stubEnv('MAILEROO_API_KEY', 'test-key');
    vi.stubEnv('MAILEROO_TRANSACTIONAL_API_KEY', '');
    vi.stubEnv('MAILEROO_NEWSLETTER_API_KEY', '');
    vi.stubEnv('MAILEROO_ACCOUNT_API_KEY', '');
    vi.stubEnv('RESEND_API_KEY', '');
    const headers = {
      'Message-ID': '<caller@example.com>', 'message-id': '<lowercase@example.com>',
      ' MESSAGE-ID ': '<spaced@example.com>', 'Ｍessage-ID': '<unicode@example.com>',
      'In-Reply-To': '<prior@example.com>', References: '<prior@example.com>',
      'List-Unsubscribe': '<https://example.com/unsubscribe/>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Feedback-ID': 'transactional',
    };
    const originalHeaders = { ...headers };
    let sentBody: any;
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      sentBody = JSON.parse(String(options.body));
      const reserved = Object.keys(sentBody.headers || {}).some(name => name.normalize('NFKC').trim().toLowerCase() === 'message-id');
      return new Response(JSON.stringify(reserved
        ? { success: false, message: "Header 'Message-ID' is system reserved and cannot be used." }
        : { success: true, data: { reference_id: '0123456789abcdef01234567' } }), { status: reserved ? 400 : 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await sendEmailCascade([{
      payload: {
        from: 'sender@example.com', to: ['employer@example.com'], replyTo: 'candidate@example.com',
        subject: 'Application', html: '<p>Application</p>', headers,
        attachments: [{ filename: 'CV.pdf', content: 'JVBERi0x' }],
      },
      recipient: { email: 'employer@example.com' }, meta: {},
    }], { forceProvider: 'maileroo', delayMs: 0 });
    expect(result.failed).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sentBody.headers).toEqual({
      'In-Reply-To': headers['In-Reply-To'], References: headers.References,
      'List-Unsubscribe': headers['List-Unsubscribe'], 'List-Unsubscribe-Post': headers['List-Unsubscribe-Post'], 'Feedback-ID': 'transactional',
    });
    expect(sentBody.reply_to.address).toBe('candidate@example.com');
    expect(sentBody.attachments).toEqual([expect.objectContaining({ file_name: 'CV.pdf', content: 'JVBERi0x' })]);
    expect(headers).toEqual(originalHeaders);
  });

  it('keeps provider references separate from actual message IDs', () => {
    expect(replyThreadMessageId({ provider: 'maileroo', messageId: '0123456789abcdef01234567' }, '<requested@example.com>')).toBeNull();
    expect(replyThreadMessageId({ provider: 'maileroo', rfcMessageId: '<actual@example.com>' }, '<requested@example.com>')).toBe('<actual@example.com>');
    expect(replyThreadMessageId({ provider: 'maileroo', rfcMessageId: 'provider-tracking-id' }, '<requested@example.com>')).toBeNull();
  });

  it.each([false, true])('falls back only after a definite rejection (ambiguous=%s)', async ambiguous => {
    for (const [key, value] of Object.entries({
      MAILEROO_API_KEY: 'test-key', MAILEROO_TRANSACTIONAL_API_KEY: '', MAILEROO_NEWSLETTER_API_KEY: '', MAILEROO_ACCOUNT_API_KEY: '',
      RESEND_API_KEY: 'test-resend-key', MAILGUN_API_KEY: 'test-mailgun-key', MAILGUN_DOMAIN: 'example.com',
    })) vi.stubEnv(key, value);
    const posts: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return Response.json({ data: [], items: [] });
      posts.push({ url: String(url), body: JSON.parse(String(options.body)) });
      if (String(url).includes('smtp.maileroo.com')) {
        if (ambiguous) throw new TypeError('fetch failed');
        return new Response('Temporarily unavailable', { status: 503 });
      }
      if (String(url).includes('api.resend.com/emails')) return Response.json({ id: 'resend-accepted-id' });
      throw new Error('An adapter that does not preserve the dossier must not be used');
    }));
    const attachment = { filename: 'CV.pdf', content: 'JVBERi0x' };
    const result = await sendEmailCascade([{
      payload: { from: 'sender@example.com', to: ['employer@example.com'], replyTo: 'candidate@example.com', subject: 'Application', html: '<p>Application</p>', attachments: [attachment] },
      recipient: { email: 'employer@example.com' }, meta: {},
    }], { delayMs: 0, forceProvider: ASSISTED_EMAIL_PROVIDERS });
    if (ambiguous) {
      expect(posts).toHaveLength(1);
      expect(result.failed[0].ambiguousDelivery).toBe(true);
      expect(result.accepted).toHaveLength(0);
    } else {
      expect(posts).toHaveLength(2);
      expect(result.failed).toEqual([]);
      expect(result.accepted[0].provider).toBe('resend');
      expect(posts[1].body.reply_to).toBe('candidate@example.com');
      expect(posts[1].body.attachments).toEqual([attachment]);
    }
  });

  it.each([
    'www.apply.example.ch', 'http://www.apply.example.ch', 'https://apply.example.ch/CHCareers/',
    'apply.example.ch', 'apply@example.com', '/careers/apply/',
    'www.bewerben.example.ch', 'https://postuler.example.fr/',
  ])('does not follow a generic address because it contains an application word: %s', label => {
    expect(APPLY_RE.test(label)).toBe(false);
  });

  it.each([
    'Apply', 'APPLY NOW', 'Apply for this job', 'Auf diese Stelle bewerben',
    'Bewerbung starten', 'Zur Bewerbung', 'Candidati', 'Candidarsi',
    'Invia la tua candidatura', 'Candidatura online', 'Postuler', 'Postulez', 'Je postule',
  ])('still recognizes the actual application control: %s', label => {
    expect(APPLY_RE.test(label)).toBe(true);
  });
});
