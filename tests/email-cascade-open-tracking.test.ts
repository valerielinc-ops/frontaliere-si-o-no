// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_SENDERS } from '../functions/src/emailCascade.js';

// Giro di prova 2026-09-30: the application Luigi's employer received carried
// Resend's open pixel, although it went out "in the candidate's name".
const payload = {
  from: 'Luigi Prova via Frontaliere Ticino <valerie@frontaliereticino.ch>',
  to: ['employer@example.com'],
  subject: 'Candidatura per la posizione di Infermiere/a – Luigi Prova',
  html: '<p>Gentili Signore e Signori</p>',
};

const env: Record<string, Record<string, string>> = {
  mailgun: { MAILGUN_API_KEY: 'key', MAILGUN_DOMAIN: 'example.com' },
  mailjet: { MAILJET_API_KEY: 'key', MAILJET_SECRET_KEY: 'secret' },
  maileroo: { MAILEROO_API_KEY: 'key' },
  resend: { RESEND_API_KEY: 'key' },
};
const replies: Record<string, unknown> = {
  mailgun: { id: 'mg-1' },
  mailjet: { Messages: [{ Status: 'success', To: [{ Email: 'employer@example.com', MessageUUID: 'mj-1', MessageID: 1 }] }] },
  maileroo: { success: true, data: { reference_id: 'ml-1' } },
  resend: { id: 're-1' },
};
const realFetch = globalThis.fetch;
const saved = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
});

/** What the provider's HTTP request asked for, as a flat reader. */
async function sent(provider: string, email: Record<string, unknown>) {
  Object.assign(process.env, env[provider]);
  let body: any = null;
  globalThis.fetch = (async (_url: string, init: any) => {
    body = init?.body;
    return { ok: true, status: 200, json: async () => replies[provider], text: async () => JSON.stringify(replies[provider]) };
  }) as any;
  await (PROVIDER_SENDERS as any)[provider]({ ...payload, ...email }, null);
  if (body && typeof body.get === 'function') return (key: string) => body.get(key);
  const json = typeof body === 'string' ? JSON.parse(body) : body;
  return (key: string) => key.split('.').reduce((value: any, part) => value?.[part], json);
}

describe('open tracking', () => {
  it('drops the pixel on every provider when a message asks for it', async () => {
    const off = { tracking: false, openTracking: false };
    expect((await sent('mailgun', off))('o:tracking-opens')).toBe('no');
    expect((await sent('mailjet', off))('Messages.0.TrackOpens')).toBe('disabled');
    expect((await sent('maileroo', off))('tracking')).toBe(false);
    expect((await sent('resend', off))('open_tracking')).toBe(false);
  });

  it('keeps the pixel for every other message', async () => {
    expect((await sent('mailgun', {}))('o:tracking-opens')).toBe('yes');
    expect((await sent('mailjet', {}))('Messages.0.TrackOpens')).toBeUndefined();
    expect((await sent('maileroo', {}))('tracking')).toBe(true);
    expect((await sent('resend', { tracking: false }))('open_tracking')).toBe(true);
  });
});
