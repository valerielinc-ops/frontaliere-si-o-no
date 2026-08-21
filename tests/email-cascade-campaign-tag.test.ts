// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendEmailCascade } from '../scripts/lib/email-cascade.mjs';

/**
 * The send half of the campaign-attribution fix (2026-08-20).
 *
 * Mailgun's `o:tag` carries VALUES only — the name is dropped in transit — so
 * the webhook had no way to tell which of ["welcome_job","lifecycle","en"] was
 * the campaign and filed every event under the raw message id instead. A custom
 * variable (`v:campaign_id`) keeps the name, and is what
 * newsletterMailgunWebhookCore.extractCampaignId now reads first.
 */
describe('sendEmailCascade — mailgun campaign custom variable', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MAILGUN_API_KEY = 'test-key';
    process.env.MAILGUN_DOMAIN = 'frontaliereticino.ch';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
  });

  async function sendWithTags(tags) {
    const captured = {};
    globalThis.fetch = (async (url, opts) => {
      if (String(url).includes('/messages') && opts?.method === 'POST') {
        captured.campaignVar = opts.body.get('v:campaign_id');
        captured.tags = opts.body.getAll('o:tag');
        return { ok: true, status: 200, json: async () => ({ id: 'mg-1' }), text: async () => '{}' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
    const { sent, failed } = await sendEmailCascade(
      [{
        payload: { from: 'a@b.ch', to: ['x@y.com'], subject: 's', html: '<p>h</p>', tags },
        recipient: { email: 'x@y.com' },
        meta: {},
      }],
      { forceProvider: 'mailgun', delayMs: 0 },
    );
    expect(failed.length).toBe(0);
    expect(sent.length).toBe(1);
    return captured;
  }

  it('stamps v:campaign_id from the campaign_id tag, by name and not by position', async () => {
    const captured = await sendWithTags([
      { name: 'type', value: 'lifecycle' },
      { name: 'campaign_id', value: 'onboarding_drip_step_1' },
      { name: 'locale', value: 'it' },
    ]);
    expect(captured.campaignVar).toBe('onboarding_drip_step_1');
  });

  it('still sends the bare o:tag values, so nothing that read them breaks', async () => {
    const captured = await sendWithTags([
      { name: 'campaign_id', value: 'weekly_2026-08-17' },
      { name: 'locale', value: 'de' },
    ]);
    expect(captured.tags).toEqual(['weekly_2026-08-17', 'de']);
  });

  it('sends no custom variable at all when the payload carries no tags', async () => {
    const captured = await sendWithTags(undefined);
    expect(captured.campaignVar).toBeNull();
  });
});
