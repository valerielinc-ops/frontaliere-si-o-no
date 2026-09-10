// @vitest-environment node
// @ts-nocheck
import { sendEmailCascade, PROVIDER_SENDERS } from '../functions/src/emailCascade.js';

const payload = {
  from: 'Sender <sender@example.com>',
  to: ['recipient@example.com'],
  subject: 'ack contract',
  html: '<p>ack contract</p>',
};

const providers = [
  {
    id: 'mailjet',
    env: { MAILJET_API_KEY: 'key', MAILJET_SECRET_KEY: 'secret' },
    identified: { Messages: [{ To: [{ MessageID: 'mailjet-provider-id' }] }] },
    empty: { Messages: [{ Status: 'success', To: [{}] }] },
  },
  {
    id: 'mailgun',
    env: { MAILGUN_API_KEY: 'key', MAILGUN_DOMAIN: 'example.com' },
    identified: { id: 'mailgun-provider-id' },
    empty: {},
  },
  {
    id: 'mailtrap',
    env: { MAILTRAP_API_TOKEN: 'token' },
    identified: { message_ids: ['mailtrap-provider-id'] },
    empty: { message_ids: [] },
  },
  {
    id: 'maileroo',
    env: { MAILEROO_API_KEY: 'key' },
    identified: { success: true, data: { reference_id: 'maileroo-provider-id' } },
    empty: { success: true, data: {} },
  },
  {
    id: 'resend',
    env: { RESEND_API_KEY: 'key' },
    identified: { id: 'resend-provider-id' },
    empty: {},
  },
  {
    id: 'cloudflare',
    env: { CF_API_TOKEN: 'token', CF_ACCOUNT_ID: 'account' },
    identified: { success: true, result: { message_id: 'cloudflare-provider-id' } },
    empty: { success: true, result: { delivered: [], queued: [] } },
  },
];

const envKeys = [
  'MAILJET_API_KEY',
  'MAILJET_SECRET_KEY',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'MAILTRAP_API_TOKEN',
  'MAILEROO_API_KEY',
  'RESEND_API_KEY',
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
];

function response(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

describe('email cascade provider ack contract', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of envKeys) delete process.env[key];
  });

  it.each(providers)('$id returns identified only for a provider id', async (provider) => {
    Object.assign(process.env, provider.env);
    globalThis.fetch = async () => response(provider.identified);

    await expect(PROVIDER_SENDERS[provider.id](payload, null)).resolves.toEqual({
      messageId: `${provider.id}-provider-id`,
      provider: provider.id,
      ack: 'identified',
    });
  });

  it('does not identify a large numeric Mailjet id after JSON parsing rounds it', async () => {
    Object.assign(process.env, { MAILJET_API_KEY: 'key', MAILJET_SECRET_KEY: 'secret' });
    const parsedNumericId = JSON.parse('{"MessageID":288230415932659101}').MessageID;
    globalThis.fetch = async () => response({ Messages: [{ To: [{ MessageID: parsedNumericId }] }] });

    await expect(PROVIDER_SENDERS.mailjet(payload, null)).resolves.toEqual({
      messageId: null,
      provider: 'mailjet',
      ack: 'unidentifiable',
    });
  });

  it.each([
    ['mailtrap', { MAILTRAP_API_TOKEN: 'token' }, { message_ids: [{ id: 'mailtrap-nested-id' }] }],
    ['maileroo', { MAILEROO_API_KEY: 'key' }, { success: true, data: { reference_id: { id: 'maileroo-nested-id' } } }],
  ])('%s extracts an id from a nested provider ack', async (provider, env, body) => {
    Object.assign(process.env, env);
    globalThis.fetch = async () => response(body);

    await expect(PROVIDER_SENDERS[provider](payload, null)).resolves.toEqual({
      messageId: `${provider}-nested-id`,
      provider,
      ack: 'identified',
    });
  });

  it.each(providers)('$id preserves a 2xx response without an id as unidentifiable', async (provider) => {
    Object.assign(process.env, provider.env);
    globalThis.fetch = async () => response(provider.empty);

    await expect(PROVIDER_SENDERS[provider.id](payload, null)).resolves.toEqual({
      messageId: null,
      provider: provider.id,
      ack: 'unidentifiable',
    });
  });

  it('does not retry a 2xx without an id on the next provider', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
      MAILJET_API_KEY: 'key',
      MAILJET_SECRET_KEY: 'secret',
    });
    let mailgunSends = 0;
    let mailjetSends = 0;
    globalThis.fetch = async (url, options) => {
      const target = String(url);
      if (target.includes('/stats/total')) return response({ stats: [] });
      if (target.includes('statcounters')) return response({ Data: [] });
      if (target.includes('mailgun.net') && options?.method === 'POST') {
        mailgunSends += 1;
        return response({});
      }
      if (target.includes('mailjet.com') && options?.method === 'POST') {
        mailjetSends += 1;
        return response({ Messages: [{ To: [{ MessageID: 'mailjet-fallback-id' }] }] });
      }
      return response({});
    };

    const result = await sendEmailCascade([{
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    }], { delayMs: 0 });

    expect(result.failed).toHaveLength(0);
    expect(result.accepted).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({ messageId: null, provider: 'mailgun', ack: 'unidentifiable' });
    expect(mailgunSends).toBe(1);
    expect(mailjetSends).toBe(0);
  });

  it('E-NEG-13-2xx-without-id-not-accepted', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
    });
    globalThis.fetch = async () => response({});

    const result = await sendEmailCascade([{
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    }], { forceProvider: 'mailgun', delayMs: 0 });

    expect(result.accepted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('E-NEG-13-2xx-without-id-is-ambiguous', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
    });
    globalThis.fetch = async () => response({});

    const result = await sendEmailCascade([{
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    }], { forceProvider: 'mailgun', delayMs: 0 });

    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({
      messageId: null,
      provider: 'mailgun',
      ack: 'unidentifiable',
    });
    expect(result.failed).toHaveLength(0);
  });

  it('E-NEG-13-no-synthetic-id-in-accepted', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
    });
    globalThis.fetch = async () => response({});

    const result = await sendEmailCascade([{
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    }], { forceProvider: 'mailgun', delayMs: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.ambiguous[0]?.messageId).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/mg-\d+/);
  });

  it('does not move an accepted send to failed when onSent throws', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
    });
    globalThis.fetch = async () => response({ id: 'mailgun-provider-id' });
    let callbackCalls = 0;

    const result = await sendEmailCascade([{
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    }], {
      forceProvider: 'mailgun',
      delayMs: 0,
      onSent: () => {
        callbackCalls += 1;
        throw new Error('bookkeeping failed');
      },
    });

    expect(callbackCalls).toBe(1);
    expect(result.sent).toHaveLength(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('exposes identified and ambiguous sends separately in providerBreakdown', async () => {
    Object.assign(process.env, {
      MAILGUN_API_KEY: 'key',
      MAILGUN_DOMAIN: 'example.com',
    });
    let sendCount = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('mailgun.net') && options?.method === 'POST') {
        sendCount += 1;
        return response(sendCount === 1 ? { id: 'mailgun-provider-id' } : {});
      }
      return response({ stats: [] });
    };

    const item = {
      payload,
      recipient: { email: 'recipient@example.com' },
      meta: {},
    };
    const result = await sendEmailCascade([item, { ...item, recipient: { email: 'second@example.com' } }], {
      forceProvider: 'mailgun',
      delayMs: 0,
    });

    expect(result.providerBreakdown).toEqual({
      mailgun: { identified: 1, ambiguous: 1 },
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.sent).toHaveLength(2);
  });
});
