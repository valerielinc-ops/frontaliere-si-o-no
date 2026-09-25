/**
 * The job context of a confirmation cycle is decided ONCE, by request #1, and
 * repeated by every later request of the cycle (the #9716 review nit).
 *
 * Measured 2026-09-25: the reminders re-read `job_company`, `job_location`,
 * `source_cta` and `source_page`, which a later signup overwrites, while the
 * title comes from the first-touch `source` — in 35 cycles the offer changed
 * between request #1 and the last reminder. These tests drive both senders
 * end to end, with the provider mocked so no email can leave:
 *   - the Cloud Function writes the snapshot in the same transaction as the
 *     counter, and a "resend" on the same cycle repeats it — title, company
 *     and the page the link returns to;
 *   - the follow-up runner writes it in the same batch as the counter.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cascade } = vi.hoisted(() => ({
  cascade: {
    sent: [] as any[],
  },
}));

vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: async (items: any[]) => {
    cascade.sent.push(...items);
    return { sent: items.map((it, i) => ({ ...it, messageId: `mid-${cascade.sent.length}-${i}` })), failed: [] };
  },
  PROVIDERS: [{ id: 'fake' }],
  isProviderConfigured: () => true,
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: async () => {},
  getNewsletterTokenPolicyConfig: async () => ({}),
  getRemoteConfigValue: async () => null,
}));

import { sendNewsletterConfirmationEmail } from '../functions/src/newsletterConfirmationEmail.js';
import { sendConfirmationRequests } from '../scripts/newsletter-confirmation-followups.mjs';
import { CONFIRMATION_JOB_CONTEXT_FIELD } from '../functions/src/lib/confirmationJobContext.js';

const EMAIL = 'snapshot@example.com';
const A_PATH = '/cerca-lavoro-ticino/driver-kulm-hotel/';
const B_PATH = '/cerca-lavoro-ticino/chemist-siegfried/';
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/** Offer A: the signup that started the cycle. */
const offerA = () => ({
  email: EMAIL,
  status: 'pending',
  isActive: false,
  created_at: hoursAgo(1),
  source: 'job_gate:Kulm Hotel St. Moritz:Driver (m/w/d)',
  source_cta: 'job_board_email_unlock',
  source_channel: 'job_gate',
  source_page: A_PATH,
  job_company: 'Kulm Hotel St. Moritz',
  job_location: 'Pontresina, Switzerland',
});

/** Offer B, a later signup: every last-touch field moves, `source` stays. */
const offerB = {
  source_cta: 'job_expired_email_unlock',
  source_page: B_PATH,
  job_company: 'Siegfried AG',
  job_location: 'Zofingen, Switzerland',
};

/**
 * One subscriber document, a transaction that applies its writes, and the
 * `events` subcollection. Admin-SDK semantics only where the sender relies on
 * them: `update` merges top-level fields, a missing document reads as absent.
 */
function memoryDb(initial: Record<string, any>) {
  let doc: Record<string, any> | null = { ...initial };
  const events: any[] = [];
  const snap = () => ({ exists: doc !== null, data: () => (doc ? { ...doc } : undefined) });
  const subRef: any = {
    get: async () => snap(),
    collection: () => ({ doc: () => ({ __event: true }) }),
  };
  const db = {
    collection: () => ({ doc: () => subRef }),
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        get: async () => snap(),
        update: (_ref: any, data: any) => { doc = { ...(doc || {}), ...data }; },
        set: (ref: any, data: any) => {
          if (ref.__event) events.push(data);
          else doc = { ...(doc || {}), ...data };
        },
      };
      return fn(tx);
    },
  };
  return {
    db,
    events,
    read: () => doc!,
    patch: (fields: Record<string, any>) => { doc = { ...(doc || {}), ...fields }; },
  };
}

beforeEach(() => {
  cascade.sent.length = 0;
});

describe('the Cloud Function freezes request #1 and repeats it on a resend', () => {
  it('stores the snapshot with the counter, then names the same offer after a signup on another one', async () => {
    const store = memoryDb(offerA());

    const first = await sendNewsletterConfirmationEmail({
      email: EMAIL, locale: 'it', sourcePath: `${A_PATH}?utm_source=mail#offer`, secret: 'test-secret', db: store.db, purpose: 'confirm',
    });
    expect(first.success).toBe(true);
    expect(cascade.sent).toHaveLength(1);
    expect(cascade.sent[0].payload.subject).toContain('Driver (m/w/d)');

    const stored = store.read();
    expect(stored.confirmation_attempts).toBe(1);
    expect(stored[CONFIRMATION_JOB_CONTEXT_FIELD]).toEqual({
      kind: 'unlocked',
      title: 'Driver (m/w/d)',
      company: 'Kulm Hotel St. Moritz',
      location: null,
      return_path: A_PATH,
    });
    expect(cascade.sent[0].payload.html).toContain(`${A_PATH}?action=confirm_newsletter`);
    expect(cascade.sent[0].payload.html).not.toContain('utm_source=mail');

    // A day later the person unlocks offer B; the last-touch fields move. The
    // stamps are rewritten as ISO strings so the cooldown reads a real date.
    store.patch({ ...offerB, confirmation_sent_at: hoursAgo(25), confirmation_first_sent_at: hoursAgo(25) });

    const resend = await sendNewsletterConfirmationEmail({
      email: EMAIL, locale: 'it', sourcePath: B_PATH, secret: 'test-secret', db: store.db, purpose: 'confirm',
    });
    expect(resend.success).toBe(true);
    expect(cascade.sent).toHaveLength(2);
    const { subject, html } = cascade.sent[1].payload;
    expect(subject).toContain('Driver (m/w/d)');
    expect(html).toContain('Kulm Hotel St. Moritz');
    expect(html).not.toContain('Siegfried');
    expect(html).toContain(`${A_PATH}?action=confirm_newsletter`);
    expect(html).not.toContain(B_PATH);
    expect(store.read().confirmation_attempts).toBe(2);
    expect(store.read()[CONFIRMATION_JOB_CONTEXT_FIELD]).toEqual(stored[CONFIRMATION_JOB_CONTEXT_FIELD]);
  });

  it('a login link neither uses nor writes the snapshot', async () => {
    const store = memoryDb({ ...offerA(), status: 'confirmed', isActive: true, confirmed_at: hoursAgo(48) });
    const result = await sendNewsletterConfirmationEmail({
      email: EMAIL, locale: 'it', sourcePath: A_PATH, secret: 'test-secret', db: store.db, purpose: 'login',
    });
    expect(result.success).toBe(true);
    expect(cascade.sent[0].payload.subject).not.toContain('Driver');
    expect(store.read()).not.toHaveProperty(CONFIRMATION_JOB_CONTEXT_FIELD);
  });

  it('a document mixing two offers gets the generic request #1, frozen as null', async () => {
    const store = memoryDb({ ...offerA(), ...offerB, source_cta: 'job_board_email_unlock' });
    const result = await sendNewsletterConfirmationEmail({
      email: EMAIL, locale: 'it', sourcePath: B_PATH, secret: 'test-secret', db: store.db, purpose: 'confirm',
    });
    expect(result.success).toBe(true);
    const { subject, html } = cascade.sent[0].payload;
    expect(subject).not.toContain('Driver');
    expect(html).not.toContain('Siegfried');
    expect(store.read()).toHaveProperty(CONFIRMATION_JOB_CONTEXT_FIELD, null);
  });
});

describe('the follow-up runner writes the snapshot in the same batch as the counter', () => {
  it('commits counter, snapshot and event together, per recipient', async () => {
    const commits: Array<Array<{ ref: any; data: any }>> = [];
    const db = {
      batch() {
        const staged: Array<{ ref: any; data: any }> = [];
        return {
          set: (ref: any, data: any) => staged.push({ ref, data }),
          update: (ref: any, data: any) => staged.push({ ref, data }),
          delete: () => {},
          commit: async () => { commits.push(staged); },
        };
      },
    };
    const ref = { __doc: EMAIL, collection: () => ({ doc: () => ({ __event: true }) }) };
    // A legacy document: asked once before the snapshot existed.
    const due = [{
      id: EMAIL,
      ref,
      data: { ...offerA(), confirmation_attempts: 1, confirmation_first_sent_at: hoursAgo(25), confirmation_sent_at: hoursAgo(25) },
      decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' },
    }];

    await sendConfirmationRequests(db, due, { nowIso: new Date().toISOString(), secret: 'test-secret' });

    expect(commits).toHaveLength(1);
    const [docWrite, eventWrite] = commits[0];
    expect(docWrite.ref).toBe(ref);
    expect(docWrite.data).toMatchObject({
      confirmation_attempts: 2,
      [CONFIRMATION_JOB_CONTEXT_FIELD]: {
        kind: 'unlocked', title: 'Driver (m/w/d)', company: 'Kulm Hotel St. Moritz', location: null, return_path: A_PATH,
      },
    });
    expect(eventWrite.data.event_type).toBe('confirmation_email_sent');
  });
});

describe('firestore.rules keeps the snapshot server-owned', () => {
  // The behaviour is asserted against the emulator in
  // tests/firestore-rules-consent-write.test.ts (`npm run test:firestore-rules`,
  // excluded from the related-tests gate because it needs Java 21). This is the
  // part CI can check without it: both browser entry points carry the guard.
  const rules = readFileSync('firestore.rules', 'utf8');
  const block = rules.slice(rules.indexOf('match /newsletter_subscribers/{email}'));
  const clause = (name: string) => block.slice(block.indexOf(`allow ${name}:`), block.indexOf(';', block.indexOf(`allow ${name}:`)));

  it('refuses the field on create and on every update clause', () => {
    expect(clause('create')).toMatch(/^allow create: if !request\.resource\.data\.keys\(\)\.hasAny\(\['confirmation_job_context'\]\)\s*&& \(/);
    expect(clause('update')).toMatch(/^allow update: if !confirmationJobSnapshotTouched\(request\.resource\.data, resource\.data\)\s*&& \(/);
    expect(rules).toMatch(/function confirmationJobSnapshotTouched\(newData, oldData\) \{\s*return newData\.diff\(oldData\)\.affectedKeys\(\)\.hasAny\(\['confirmation_job_context'\]\);/);
  });

  it('names the same field the senders write', () => {
    expect(rules).toContain(`'${CONFIRMATION_JOB_CONTEXT_FIELD}'`);
  });
});
