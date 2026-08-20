import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  campaignIdFromTags,
  recordMailerooRef,
  makeMailerooRefOnSent,
} from '../functions/src/lib/mailerooRef.js';

/**
 * Minimal Firestore double: records every set() so a test can assert the doc id,
 * the merge flag and the payload without a real admin SDK.
 */
function fakeDb() {
  const sets: Array<{ docId: string; merge: boolean; data: any }> = [];
  const db = {
    collection: (_c: string) => ({
      doc: (_d: string) => ({
        collection: (_sub: string) => ({
          doc: (docId: string) => ({
            set: async (data: any, opts: any) => {
              sets.push({ docId, merge: !!opts?.merge, data });
            },
          }),
        }),
      }),
    }),
  };
  return { db, sets };
}

describe('campaignIdFromTags — both tag shapes occur in production', () => {
  it('reads the array-of-{name,value} shape the senders build', () => {
    expect(campaignIdFromTags([
      { name: 'type', value: 'lifecycle' },
      { name: 'campaign_id', value: 'onboarding_drip_step_1' },
    ])).toBe('onboarding_drip_step_1');
  });

  it('reads the flattened object shape the cascade hands to Maileroo', () => {
    expect(campaignIdFromTags({ campaign_id: 'weekly_2026-08-17', type: 'newsletter' }))
      .toBe('weekly_2026-08-17');
  });

  it('accepts `campaign` as an alias in both shapes', () => {
    expect(campaignIdFromTags([{ name: 'campaign', value: 'x' }])).toBe('x');
    expect(campaignIdFromTags({ campaign: 'y' })).toBe('y');
  });

  it('returns the empty string — never null — when there is no campaign tag', () => {
    expect(campaignIdFromTags(undefined)).toBe('');
    expect(campaignIdFromTags([])).toBe('');
    expect(campaignIdFromTags([{ name: 'locale', value: 'it' }])).toBe('');
    expect(campaignIdFromTags({ type: 'lifecycle' })).toBe('');
  });
});

describe('recordMailerooRef — the record Maileroo engagement cannot be attributed without', () => {
  it('writes the lookup for a Maileroo send', async () => {
    const { db, sets } = fakeDb();
    const wrote = await recordMailerooRef(db, {
      provider: 'maileroo',
      messageId: 'ref_1',
      email: 'seeker@example.com',
      campaignId: 'onboarding_drip_step_1',
      isJobAlert: false,
    });
    expect(wrote).toBe(true);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      docId: 'ref_1',
      merge: true,
      data: { email: 'seeker@example.com', campaign_id: 'onboarding_drip_step_1', is_job_alert: false },
    });
  });

  it('normalizes the address, because the webhook uses it as the subscriber doc id', async () => {
    const { db, sets } = fakeDb();
    await recordMailerooRef(db, {
      provider: 'maileroo', messageId: 'ref_2', email: '  Seeker@Example.COM ', campaignId: 'c',
    });
    expect(sets[0].data.email).toBe('seeker@example.com');
  });

  it('writes nothing for the four providers whose webhooks carry the recipient', async () => {
    const { db, sets } = fakeDb();
    for (const provider of ['resend', 'mailgun', 'mailjet', 'mailtrap']) {
      await recordMailerooRef(db, { provider, messageId: 'x', email: 'a@b.com', campaignId: 'c' });
    }
    expect(sets).toHaveLength(0);
  });

  it('writes nothing without a message id or a usable address', async () => {
    const { db, sets } = fakeDb();
    await recordMailerooRef(db, { provider: 'maileroo', email: 'a@b.com', campaignId: 'c' });
    await recordMailerooRef(db, { provider: 'maileroo', messageId: 'x', email: '', campaignId: 'c' });
    await recordMailerooRef(db, { provider: 'maileroo', messageId: 'x', email: 'not-an-address', campaignId: 'c' });
    expect(sets).toHaveLength(0);
  });

  it('never throws — the message is already gone, bookkeeping must not break the sender', async () => {
    const exploding = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        set: async () => { throw new Error('firestore down'); },
      }) }) }) }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordMailerooRef(exploding, {
      provider: 'maileroo', messageId: 'x', email: 'a@b.com', campaignId: 'c',
    })).resolves.toBe(false);
    warn.mockRestore();
  });
});

describe('makeMailerooRefOnSent — composes with the sender own callback', () => {
  it('records the ref and then calls the caller onSent, in that order', async () => {
    const { db, sets } = fakeDb();
    const calls: string[] = [];
    const next = async () => { calls.push('next'); };
    const onSent = makeMailerooRefOnSent(async () => { calls.push('ref'); return db; }, {
      defaultCampaignId: 'daily-brief', next,
    });
    await onSent(
      { recipient: { email: 'a@b.com' }, payload: { tags: [{ name: 'campaign_id', value: 'daily-brief-2026-08-20' }] } },
      { provider: 'maileroo', messageId: 'm1' },
    );
    expect(calls).toEqual(['ref', 'next']);
    expect(sets[0].data.campaign_id).toBe('daily-brief-2026-08-20');
  });

  it('falls back to the channel id when the payload carries no campaign tag', async () => {
    const { db, sets } = fakeDb();
    const onSent = makeMailerooRefOnSent(async () => db, { defaultCampaignId: 'job-alert', isJobAlert: true });
    await onSent({ recipient: { email: 'a@b.com' }, payload: { tags: [{ name: 'type', value: 'job-alert' }] } },
      { provider: 'maileroo', messageId: 'm2' });
    expect(sets[0].data).toMatchObject({ campaign_id: 'job-alert', is_job_alert: true });
  });

  it('still calls the caller onSent for a non-Maileroo send', async () => {
    const { db } = fakeDb();
    let called = false;
    const onSent = makeMailerooRefOnSent(async () => db, { next: async () => { called = true; } });
    await onSent({ recipient: { email: 'a@b.com' }, payload: {} }, { provider: 'mailgun', messageId: 'm3' });
    expect(called).toBe(true);
  });

  it('does not initialise Firestore at all when the send did not go via Maileroo', async () => {
    let dbAsked = false;
    const onSent = makeMailerooRefOnSent(async () => { dbAsked = true; return fakeDb().db; }, {});
    await onSent({ recipient: { email: 'a@b.com' }, payload: {} }, { provider: 'resend', messageId: 'm4' });
    expect(dbAsked).toBe(false);
  });
});

/**
 * The structural half — the reason the gap existed for months.
 *
 * Every scripts/ sender goes through scripts/lib/email-cascade.mjs, whose
 * wrapper attaches the ref writer for all of them at once. Cloud-Functions
 * senders import functions/src/emailCascade.js DIRECTLY and so bypass that
 * wrapper by design (a CF must not spend its request budget on the link-audit
 * probes attached there). That bypass is exactly how welcome and confirmation
 * lost their engagement tracking, so a new CF sender must not be able to
 * inherit the same hole by simply not thinking about it: it has to appear in
 * one of the two lists below, which forces the decision to be written down.
 */
const CF_SENDERS_REQUIRING_REF = [
  'newsletterWelcomeEmail.js',
  'newsletterConfirmationEmail.js',
  'sendCalculatorReport.js',
];

const CF_SENDERS_EXEMPT: Record<string, string> = {
  'consultingCore.js': 'one-off reply to a consulting request; the recipient is not a newsletter_subscribers doc, so the webhook would skip the event anyway',
  'publisherApplicationsCore.js': 'publisher application outcome; recipient is a publisher, not a subscriber',
  'publisherRenewalCore.js': 'publisher renewal notice; recipient is a publisher, not a subscriber',
  'stripePublisherCore.js': 'Stripe billing notices; recipient is a paying publisher, not a subscriber',
};

describe('every Cloud-Functions sender is a deliberate choice about engagement tracking', () => {
  const fnDir = path.join(__dirname, '..', 'functions', 'src');

  const senders = fs.readdirSync(fnDir)
    .filter((f) => f.endsWith('.js') && f !== 'emailCascade.js')
    .filter((f) => /(?:await|=)\s*sendEmailCascade\(/.test(fs.readFileSync(path.join(fnDir, f), 'utf8')));

  it('finds the senders it is meant to police', () => {
    expect(senders.length).toBeGreaterThan(0);
  });

  it('classifies every sender as either ref-writing or explicitly exempt', () => {
    const unclassified = senders.filter(
      (f) => !CF_SENDERS_REQUIRING_REF.includes(f) && !(f in CF_SENDERS_EXEMPT),
    );
    expect(
      unclassified,
      `New Cloud-Functions email sender(s) not classified in tests/maileroo-ref.test.ts: ${unclassified.join(', ')}. `
      + 'Either wire makeMailerooRefOnSent into the sendEmailCascade call and add the file to CF_SENDERS_REQUIRING_REF, '
      + 'or add it to CF_SENDERS_EXEMPT with the reason its recipients are not subscribers.',
    ).toEqual([]);
  });

  it('each ref-writing sender actually imports the shared writer', () => {
    for (const f of CF_SENDERS_REQUIRING_REF) {
      const src = fs.readFileSync(path.join(fnDir, f), 'utf8');
      expect(src, `${f} must import makeMailerooRefOnSent from ./lib/mailerooRef.js`)
        .toMatch(/makeMailerooRefOnSent/);
      expect(src, `${f} must pass onSent to sendEmailCascade`).toMatch(/onSent:\s*makeMailerooRefOnSent/);
    }
  });

  it('every exemption carries a written reason', () => {
    for (const [f, reason] of Object.entries(CF_SENDERS_EXEMPT)) {
      expect(reason.length, `${f} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });
});

describe('the scripts/ wrapper attaches the ref writer for every scripts sender', () => {
  it('scripts/lib/email-cascade.mjs wires makeMailerooRefOnSent into its cascade override', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'email-cascade.mjs'), 'utf8');
    expect(src).toMatch(/makeMailerooRefOnSent/);
    // It must be attached to the exported override, not merely imported.
    const override = src.slice(src.indexOf('export async function sendEmailCascade'));
    expect(override).toMatch(/onSent:\s*makeMailerooRefOnSent/);
  });
});
