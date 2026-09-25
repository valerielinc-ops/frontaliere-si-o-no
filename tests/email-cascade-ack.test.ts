// @vitest-environment node
// @ts-nocheck
import { sendEmailCascade, PROVIDER_SENDERS } from '../functions/src/emailCascade.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';

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
    // The Send API v3.1 shape: a string UUID next to a numeric legacy id.
    identified: { Messages: [{ Status: 'success', To: [{ Email: 'recipient@example.com', MessageUUID: 'mailjet-provider-id', MessageID: 456, MessageHref: 'https://api.mailjet.com/v3/message/456' }] }] },
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

  it('identifies a Mailjet send by MessageUUID — the id its webhook events carry as Message_GUID', async () => {
    // The response exactly as it crosses the wire: `MessageID` past 2^53 is
    // rounded by JSON.parse (…431917 → …431872), the UUID is a string and
    // survives. Before this fix the sender read `MessageID`, so it stored a
    // fabricated id (until #8245) and then no id at all.
    Object.assign(process.env, { MAILJET_API_KEY: 'key', MAILJET_SECRET_KEY: 'secret' });
    const uuid = '2f6c1d0e-9a8b-4c7d-8e6f-5a4b3c2d1e0f';
    const wire = `{"Messages":[{"Status":"success","CustomID":"confirmation","To":[{"Email":"recipient@example.com","MessageUUID":"${uuid}","MessageID":1152921544112431917,"MessageHref":"https://api.mailjet.com/v3/REST/message/1152921544112431917"}],"Cc":[],"Bcc":[]}]}`;
    expect(String(JSON.parse(wire).Messages[0].To[0].MessageID)).not.toBe('1152921544112431917');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(wire), text: async () => wire });

    const ack = await PROVIDER_SENDERS.mailjet(payload, null);
    expect(ack).toEqual({ messageId: uuid, provider: 'mailjet', ack: 'identified' });

    // …and it is the id the Mailjet webhook stores for the same message, so a
    // send and its open/click/bounce events join on `message_id`.
    const events: any[] = [];
    const eventsRef = { add: async (data: any) => { events.push(data); }, orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) };
    const docRef: any = {
      get: async () => ({ exists: false, data: () => ({}) }),
      set: async () => {},
      collection: (name: string) => (name === 'events' ? eventsRef : { doc: () => ({ set: async () => {} }) }),
    };
    docRef.firestore = { runTransaction: async (fn: any) => fn({ get: (r: any) => r.get(), set: () => {} }) };
    const db: any = { collection: () => ({ doc: () => docRef }) };
    const webhookBody = `[{"event":"open","time":1758800000,"email":"recipient@example.com","MessageID":1152921544112431917,"Message_GUID":"${uuid}","CustomID":"confirmation"}]`;
    await persistMailjetEvent(db, JSON.parse(webhookBody)[0]);
    expect(events.map((e) => e.message_id)).toEqual([ack.messageId]);
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
    expect(result.accepted[0].persistFailed).toBe(true);
    expect(result.providerBreakdown).toEqual({
      mailgun: { identified: 1, ambiguous: 0, persistFailed: 1 },
    });
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
      mailgun: { identified: 1, ambiguous: 1, persistFailed: 0 },
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.sent).toHaveLength(2);
  });
});
