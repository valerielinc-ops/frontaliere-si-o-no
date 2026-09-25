import { describe, expect, it, vi } from 'vitest';
import { isDeletedEmailAccount } from '../functions/src/authAccountCleanup.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';

const email = 'erased@example.com';
const clickUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/?je=1&surface=newsletter&surface_id=newsletter_weekly&job_id=old-job&delivery_id=old-delivery';

// A read-only Firestore double: every mutation throws, including writes to
// ranking collections or children of the two retained suppression records.
function readOnlyDb(seed: Record<string, object>, failRead = false) {
  const write = vi.fn(() => { throw new Error('erased data was recreated'); });
  const doc = (path: string): any => ({
    get: async () => {
      if (failRead) throw new Error('Firestore unavailable');
      return { exists: path in seed, data: () => seed[path] };
    },
    set: write, update: write, delete: write,
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string): any => ({
    doc: (id: string) => doc(`${path}/${id}`), add: write,
  });
  return { collection, batch: write, runTransaction: write, write };
}

const providers = [
  ['resend', (db: any, job: boolean) => applyResendWebhookEvent({
    type: 'email.clicked', data: { email, click: { link: clickUrl }, tags: { type: job ? 'job-alert' : 'newsletter' } },
  }, { db })],
  ['mailgun', (db: any, job: boolean) => persistMailgunEvent(db, {
    event: 'clicked', recipient: email, url: clickUrl, tags: job ? ['job-alert'] : [],
  })],
  ['mailjet', (db: any, job: boolean) => persistMailjetEvent(db, {
    event: 'click', email, url: clickUrl, CustomID: job ? 'job-alert' : 'newsletter',
  })],
  ['mailtrap', (db: any, job: boolean) => persistMailtrapEvent(db, {
    event: 'click', email, url: clickUrl, category: job ? 'job-alert' : 'newsletter',
  })],
  ['maileroo', (db: any, job: boolean) => persistMailerooEvent(db, {
    event_type: 'clicked', event_data: { to: email, original_url: clickUrl }, tags: { type: job ? 'job-alert' : 'newsletter' },
  })],
] as const;

describe.each(providers)('%s callbacks after account erasure', (_provider, handle) => {
  for (const channel of ['newsletter_subscribers', 'job_alert_subscribers']) {
    for (const marker of [{ account_deleted_at: new Date().toISOString() }, { status: 'account_deleted' }]) {
      it.each([false, true])(`ignores a late click with ${Object.keys(marker)[0]} in ${channel} (job alert: %s)`, async (job) => {
        const db = readOnlyDb({ [`${channel}/${email}`]: marker });
        expect(await handle(db, job)).toMatchObject({ reason: 'account_deleted' });
        expect(db.write).not.toHaveBeenCalled();
      });
    }
  }
  it('does not bypass an unavailable erasure check', async () => {
    const db = readOnlyDb({}, true);
    await expect(handle(db, false)).rejects.toThrow('Firestore unavailable');
    expect(db.write).not.toHaveBeenCalled();
  });
});

describe('email account erasure lookup', () => {
  it.each(['confirmed', 'active', 'unsubscribed', 'suppressed'])('does not treat %s alone as account erasure', async (status) => {
    const db = readOnlyDb({ [`newsletter_subscribers/${email}`]: { status } });
    expect(await isDeletedEmailAccount(db, email)).toBe(false);
  });
  it('normalizes the email key and accepts a missing subscriber', async () => {
    expect(await isDeletedEmailAccount(readOnlyDb({}), email)).toBe(false);
    const db = readOnlyDb({ [`newsletter_subscribers/${email}`]: { status: 'account_deleted' } });
    expect(await isDeletedEmailAccount(db, ` ${email.toUpperCase()} `)).toBe(true);
  });
});
