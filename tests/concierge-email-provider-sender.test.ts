import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_SENDERS } from '../functions/src/emailCascade.js';
import { buildApplicationConciergePaymentReminderEmail } from '../functions/src/applicationConciergePaymentReminders.js';
const expectedName = 'Il tuo assistente candidature · Frontaliere Ticino';
const expectedAddress = 'confirmation@frontaliereticino.ch';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('concierge reminder sender at the provider boundary', () => {
  it.each(['mailgun', 'mailjet', 'mailtrap', 'maileroo', 'resend', 'cloudflare'])('preserves the chosen sender with %s', async (provider) => {
    for (const key of ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'MAILJET_API_KEY', 'MAILJET_SECRET_KEY',
      'MAILTRAP_API_TOKEN', 'MAILEROO_API_KEY', 'MAILEROO_TRANSACTIONAL_API_KEY', 'RESEND_API_KEY',
      'CLOUDFLARE_EMAIL_API_TOKEN', 'CF_ACCOUNT_ID']) vi.stubEnv(key, 'test-provider-value');
    let body: any;
    const reply = { id: 'test-id', message_ids: ['test-id'], success: true,
      data: { reference_id: 'test-id' }, result: { message_id: 'test-id' },
      Messages: [{ Status: 'success', To: [{ MessageUUID: 'test-id' }] }],
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, json: async () => reply, text: async () => '{}' };
    }));
    const message = buildApplicationConciergePaymentReminderEmail({
      day: 3, locale: 'it', serviceId: 'test-service', unsubscribeUrl: 'https://example.test/unsubscribe/',
    });
    expect(message.from).toBe(`${expectedName} <${expectedAddress}>`);
    expect(message.text).toContain('\n');
    expect(message.text).not.toContain('\\n');
    await (PROVIDER_SENDERS as any)[provider]({ ...message, to: ['recipient@example.test'], tracking: false }, null);
    if (body && typeof body.get === 'function') expect(body.get('from')).toBe(message.from);
    else {
      const json = JSON.parse(body);
      if (provider === 'mailjet') expect(json.Messages[0].From).toEqual({ Email: expectedAddress, Name: expectedName });
      else if (provider === 'mailtrap') expect(json.from).toEqual({ email: expectedAddress, name: expectedName });
      else if (provider === 'maileroo') expect(json.from).toEqual({ address: expectedAddress, display_name: expectedName });
      else expect(json.from).toBe(message.from);
    }
  });
});
