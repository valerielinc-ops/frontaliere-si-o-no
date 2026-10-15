/**
 * tests/optout-stamp-beats-status.test.ts — #5741 + #5750 item 2
 *
 * ONE principle, asserted from four directions: **the opt-out stamp is
 * append-only and outranks `status`.**
 *
 * `status` is a derived field. Five webhook cores, a sunset cron, a suppression
 * retry script and a restore script all write it, last one wins. The stamp
 * (`unsubscribed_at` / `unsubscribedAt`) has been append-only since #5711 —
 * nothing deletes it — so it is the durable record of a decision a *person*
 * made. When the two disagree, the person wins.
 *
 * They disagree in production. 458 documents on 2026-08-12, 77 still on
 * 2026-08-13, carry ONLY the camelCase `unsubscribedAt` written by the
 * pre-#5673 SPA path, with a `status` some later writer moved off
 * `'unsubscribed'`. Until this file, `positiveEventRecoveryFields` and
 * `positiveEventStatusFields` read `status` and nothing else, so a single
 * `open` on a transactional email — allowed to an opted-out address by design,
 * see `isTransactionalHardBlock` — was enough to stamp `status: 'active'`,
 * `isActive: true` and a `recovered_from_status` audit trail onto someone who
 * had clicked "disiscriviti".
 *
 * The four cases below are the four ways this can be got wrong, and the fourth
 * matters as much as the first three: a guard that refuses EVERYONE has also
 * failed, just quietly and in the other direction.
 *
 *   (a) camelCase stamp + a status that is not 'unsubscribed'  → must refuse
 *   (b) snake_case stamp, same shape                            → must refuse
 *   (c) a raw DocumentSnapshot instead of the document DATA     → must fail
 *       CLOSED and LOUD, never answer "not opted out" in silence
 *   (d) a legitimate subscriber with NO stamp                   → must still
 *       recover, and still be contactable
 *
 * MUTATION PROOF, measured on 2026-08-13 and re-runnable in ten seconds:
 *
 *   1. put the recovery decision back on `status` alone — delete the two
 *      `if (hasBindingOptOutStamp(subscriber)) return {};` lines in
 *      functions/src/lib/subscriberReactivation.js — and 28 of these 52 tests
 *      go red, across (a), (b) and the end-to-end provider sweep, while all of
 *      (d) stays green;
 *   2. delete the `assertSubscriberData(...)` calls instead and 7 go red, all
 *      of them in (c).
 *
 * Both mutations leave the REST of the suite green — that is why this file
 * exists rather than a line in an older one.
 *
 * Every address here is on example.com — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  positiveEventRecoveryFields,
  positiveEventStatusFields,
  instantReactivationFields,
  hasBindingOptOutStamp,
} from '../functions/src/lib/subscriberReactivation.js';
import { isCrossChannelStop } from '../functions/src/lib/emailSuppression.js';
import * as canonical from '../services/newsletterOptOut.mjs';
import * as mirror from '../functions/src/lib/newsletterOptOut.js';

import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';

const T0 = '2026-08-01T09:00:00.000Z';
const T1 = '2026-08-02T09:00:00.000Z';

/** A Firestore Timestamp, as the admin SDK hands it back. */
const ts = (iso: string) => ({ toMillis: () => Date.parse(iso) });

/**
 * A raw `DocumentSnapshot`, exactly as `subscriberRef.get()` returns it. Note
 * what it does NOT have: `.status`, `.unsubscribed_at`, `.unsubscribedAt`. Every
 * one of those reads `undefined` off it, which is why passing it instead of
 * `.data()` used to mean "this person never opted out".
 */
const rawSnapshot = (fields: Record<string, unknown>) => ({
  exists: true,
  id: 'someone@example.com',
  ref: {},
  data: () => fields,
});

/** A raw `DocumentReference` — the other handle that fails the same way. */
const rawDocRef = () => ({
  id: 'someone@example.com',
  path: 'newsletter_subscribers/someone@example.com',
  get: async () => rawSnapshot({}),
  collection: () => ({}),
  set: async () => {},
});

// ─────────────────────────────────────────────────────────────
// (a) + (b) the stamp refuses a recovery the status would allow
// ─────────────────────────────────────────────────────────────

/**
 * Every status a positive event was previously allowed to clear, paired with a
 * document that also carries an opt-out stamp. `inactive`/`suppressed`/`bounced`
 * are the MACHINE_INFERRED_SUPPRESSIONS; `pending`/`confirmed` are the
 * fall-through that `positiveEventStatusFields` promoted to `'active'`.
 */
const NON_UNSUBSCRIBED_STATUSES = ['inactive', 'suppressed', 'bounced', 'pending', 'confirmed', 'active'];

describe('(a) a camelCase `unsubscribedAt` stops the recovery whatever the status says', () => {
  it.each(NON_UNSUBSCRIBED_STATUSES)('status %s + unsubscribedAt → no recovery fields', (status) => {
    const subscriber = { status, unsubscribedAt: T0 };
    expect(positiveEventRecoveryFields({ currentStatus: status, event: 'open', subscriber })).toEqual({});
  });

  it.each(NON_UNSUBSCRIBED_STATUSES)('status %s + unsubscribedAt → no status write at all', (status) => {
    const subscriber = { status, unsubscribedAt: T0 };
    // The one that mattered most: `pending`/`confirmed` produce no recovery
    // fields, are not terminal, and therefore used to fall all the way through
    // to `{ status: 'active' }`.
    expect(positiveEventStatusFields({ currentStatus: status, event: 'delivered', subscriber })).toEqual({});
  });

  it('never fabricates the recovered_from_status audit trail on a stamped document', () => {
    const fields = positiveEventRecoveryFields({
      currentStatus: 'suppressed',
      event: 'click',
      subscriber: { status: 'suppressed', unsubscribedAt: T0 },
    });
    expect(fields.recovered_from_status).toBeUndefined();
    expect(fields.reactivated_at).toBeUndefined();
    expect(fields.isActive).toBeUndefined();
  });
});

describe('(b) a snake_case `unsubscribed_at` does exactly the same', () => {
  it.each(NON_UNSUBSCRIBED_STATUSES)('status %s + unsubscribed_at → no recovery fields', (status) => {
    const subscriber = { status, unsubscribed_at: T0 };
    expect(positiveEventRecoveryFields({ currentStatus: status, event: 'open', subscriber })).toEqual({});
    expect(positiveEventStatusFields({ currentStatus: status, event: 'open', subscriber })).toEqual({});
  });

  it('reads the stamp in every shape Firestore hands back, not just strings', () => {
    for (const stamp of [T0, new Date(T0), ts(T0), Date.parse(T0)]) {
      expect(
        positiveEventRecoveryFields({
          currentStatus: 'bounced',
          bounceSeverity: 'soft',
          event: 'delivered',
          subscriber: { status: 'bounced', unsubscribed_at: stamp },
        }),
        `stamp shape ${JSON.stringify(stamp)} was not honoured`,
      ).toEqual({});
    }
  });

  it('an UNREADABLE stamp is still a stamp — present ≠ orderable', () => {
    expect(positiveEventRecoveryFields({
      currentStatus: 'suppressed',
      event: 'open',
      subscriber: { status: 'suppressed', unsubscribedAt: 'not-a-date' },
    })).toEqual({});
  });

  it('the narrow sunset helper is stamp-aware too when given the document', () => {
    expect(instantReactivationFields('inactive', { status: 'inactive', unsubscribedAt: T0 })).toEqual({});
    // ...and unchanged for its historical one-argument callers.
    expect(instantReactivationFields('inactive').status).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────
// (c) a raw DocumentSnapshot fails CLOSED and LOUD
// ─────────────────────────────────────────────────────────────

describe('(c) a raw Firestore handle can never be mistaken for document data', () => {
  const SNAPSHOT = rawSnapshot({ status: 'unsubscribed', unsubscribedAt: T0 });

  it('positiveEventRecoveryFields throws instead of silently recovering', () => {
    expect(() => positiveEventRecoveryFields({
      currentStatus: 'suppressed', event: 'open', subscriber: SNAPSHOT as never,
    })).toThrow(/snapshot\.data\(\)/);
  });

  it('positiveEventStatusFields throws instead of silently promoting to active', () => {
    expect(() => positiveEventStatusFields({
      currentStatus: 'pending', event: 'delivered', subscriber: SNAPSHOT as never,
    })).toThrow(TypeError);
  });

  it('hasBindingOptOutStamp throws rather than answering false', () => {
    expect(() => hasBindingOptOutStamp(SNAPSHOT as never)).toThrow(/not document data/);
  });

  it.each([
    ['canonical services/newsletterOptOut.mjs', canonical],
    ['pinned mirror functions/src/lib/newsletterOptOut.js', mirror],
  ])('%s throws from every reader', (_name, mod: any) => {
    for (const fn of [
      'isNewsletterOptOutBinding',
      'isNewsletterOptOutSuperseded',
      'hasNewsletterOptOutStamp',
      'newsletterOptOutMillis',
      'newsletterReOptInMillis',
    ]) {
      expect(() => mod[fn](SNAPSHOT), `${fn} answered instead of throwing`).toThrow(TypeError);
    }
  });

  it('isCrossChannelStop throws — in the row position AND in the .doc projection', () => {
    expect(() => isCrossChannelStop(SNAPSHOT as never)).toThrow(/isCrossChannelStop/);
    expect(() => isCrossChannelStop({ status: 'confirmed', doc: SNAPSHOT } as never))
      .toThrow(/isCrossChannelStop\(row\.doc\)/);
  });

  it('a DocumentReference is rejected too — it reads undefined for the same reason', () => {
    expect(() => canonical.isNewsletterOptOutBinding(rawDocRef() as never)).toThrow(TypeError);
    expect(() => mirror.isNewsletterOptOutBinding(rawDocRef() as never)).toThrow(TypeError);
  });

  it('but a plain document that happens to hold a `data` FIELD is not a handle', () => {
    // The detector must key on `.data` being callable, not merely present:
    // rejecting a real document would be the same outage in reverse.
    expect(canonical.isNewsletterOptOutBinding({ status: 'confirmed', data: { anything: 1 } })).toBe(false);
    expect(canonical.isNewsletterOptOutBinding({ status: 'confirmed', data: 'a string' })).toBe(false);
    expect(canonical.isFirestoreDocHandle({ get: 'not a function', collection: 3 })).toBe(false);
  });

  it('null and undefined stay legal — "no document" is an answer, not a miswiring', () => {
    expect(() => canonical.isNewsletterOptOutBinding(null)).not.toThrow();
    expect(canonical.isNewsletterOptOutBinding(undefined)).toBe(false);
    expect(hasBindingOptOutStamp(null)).toBe(false);
    expect(positiveEventRecoveryFields({ currentStatus: 'inactive', event: 'open' }).status).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────
// (d) the specular case — the guard must not silence everyone
// ─────────────────────────────────────────────────────────────

describe('(d) a legitimate subscriber with no opt-out stamp is still recoverable and still contactable', () => {
  it('an unstamped sunset subscriber recovers on a delivered, exactly as before', () => {
    const subscriber = { status: 'inactive', email: 'alive@example.com', confirmed_at: T0 };
    const fields = positiveEventRecoveryFields({ currentStatus: 'inactive', event: 'delivered', subscriber });
    expect(fields.status).toBe('active');
    expect(fields.isActive).toBe(true);
    expect(fields.recovered_from_status).toBe('inactive');
  });

  it('an unstamped soft-bounced subscriber still recovers', () => {
    const subscriber = { status: 'bounced', bounce_severity: 'soft' };
    const fields = positiveEventRecoveryFields({
      currentStatus: 'bounced', bounceSeverity: 'soft', event: 'open', subscriber,
    });
    expect(fields.status).toBe('active');
    expect(fields.bounce_reactivated_at).toBeTruthy();
  });

  it('an unstamped pending/confirmed subscriber is still promoted to active', () => {
    for (const status of ['pending', 'confirmed']) {
      expect(
        positiveEventStatusFields({ currentStatus: status, event: 'delivered', subscriber: { status } }),
        `${status} lost its historical promotion`,
      ).toEqual({ status: 'active' });
    }
  });

  it('a subscriber who left and explicitly came back is contactable again', () => {
    // The append-only stamp is still there — it always will be. What lifts it is
    // a STRICTLY LATER explicit `resubscribed_at`, and it must keep lifting it,
    // or the fix becomes a one-way door of its own.
    const subscriber = { status: 'confirmed', unsubscribedAt: T0, resubscribed_at: T1 };
    expect(hasBindingOptOutStamp(subscriber)).toBe(false);
    expect(isCrossChannelStop(subscriber)).toBe(false);
    expect(positiveEventStatusFields({ currentStatus: 'confirmed', event: 'open', subscriber }))
      .toEqual({ status: 'active' });
  });

  it('...but an EARLIER re-opt-in does not lift anything', () => {
    const subscriber = { status: 'confirmed', unsubscribed_at: T1, resubscribed_at: T0 };
    expect(hasBindingOptOutStamp(subscriber)).toBe(true);
    expect(positiveEventStatusFields({ currentStatus: 'confirmed', event: 'open', subscriber })).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// End to end, through all five provider webhooks
// ─────────────────────────────────────────────────────────────

function createFakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string): any => ({
    doc: (docId: string) => {
      const docRef: any = {
        set: async (data: Record<string, unknown>) => { sets.push({ collection: name, docId, data }); },
        get: async () => {
          const docData = existingDocs[name]?.[docId];
          return { exists: !!docData, data: () => docData || {} };
        },
        collection: (subName: string) => {
          const subPath = `${name}/${docId}/${subName}`;
          return {
            doc: (subDocId: string) => ({
              set: async (data: Record<string, unknown>, _opts?: unknown) => {
                sets.push({ collection: subPath, docId: subDocId, data });
              },
              get: async () => {
                const docData = existingDocs[subPath]?.[subDocId];
                return { exists: !!docData, data: () => docData || undefined };
              },
            }),
            add: async (data: Record<string, unknown>) => { adds.push({ collection: subPath, data }); },
            orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
          };
        },
      };
      docRef.firestore = {
        runTransaction: async (updateFunction: (tx: any) => Promise<unknown>) => {
          const tx = {
            get: async (ref: any) => ref.get(),
            set: (ref: any, data: Record<string, unknown>, opts?: unknown) => { ref.set(data, opts); },
          };
          return updateFunction(tx);
        },
      };
      return docRef;
    },
    add: async (data: Record<string, unknown>) => { adds.push({ collection: name, data }); },
  });

  return { collection(name: string) { return makeCollection(name); }, __sets: sets, __adds: adds };
}

const EMAIL = 'left-us@example.com';

/** Fires ONE positive NEWSLETTER event per provider (no job-alert marker). */
const NEWSLETTER_POSITIVES: Array<[string, (db: any) => Promise<unknown>]> = [
  ['mailgun', (db) => persistMailgunEvent(db, {
    event: 'delivered', recipient: EMAIL, timestamp: 1700000000,
  })],
  ['mailtrap', (db) => persistMailtrapEvent(db, {
    event: 'delivery', email: EMAIL, timestamp: 1700000000,
  })],
  // Mailjet maps `sent` → send, so `open` is its cheapest positive signal.
  ['mailjet', (db) => persistMailjetEvent(db, {
    event: 'open', email: EMAIL, time: 1700000000,
  })],
  ['maileroo', (db) => persistMailerooEvent(db, {
    event_type: 'delivered', message_reference_id: 'ref_nl', event_data: { to: EMAIL },
  })],
  ['resend', (db) => applyResendWebhookEvent({
    type: 'email.delivered', data: { email: EMAIL, email_id: 'msg_nl' },
  }, { db })],
];

// Maileroo resolves the recipient from a lookup record, not from the payload.
const MAILEROO_REF = {
  'newsletter_subscribers/_meta_/maileroo_refs': {
    ref_nl: { email: EMAIL, is_job_alert: false },
  },
};

const subscriberWrite = (db: ReturnType<typeof createFakeDb>) =>
  db.__sets.find((s) => s.collection === 'newsletter_subscribers' && s.docId === EMAIL);

describe('every provider: a positive event on a stamped document writes no reactivation', () => {
  it.each(NEWSLETTER_POSITIVES)(
    '%s leaves a camelCase-stamped, machine-suppressed document alone',
    async (_provider, fire) => {
      const db = createFakeDb({
        ...MAILEROO_REF,
        newsletter_subscribers: { [EMAIL]: { status: 'suppressed', unsubscribedAt: T0 } },
      });

      await fire(db as any);

      const written = subscriberWrite(db)!.data;
      // This is the whole of #5741: before the fix these three landed on a
      // document whose owner had clicked "disiscriviti".
      expect(written.status).not.toBe('active');
      expect(written.isActive).toBeUndefined();
      expect(written.recovered_from_status).toBeUndefined();
    },
  );

  it.each(NEWSLETTER_POSITIVES)(
    '%s still recovers an UNSTAMPED suppressed document — case (d), end to end',
    async (_provider, fire) => {
      const db = createFakeDb({
        ...MAILEROO_REF,
        newsletter_subscribers: { [EMAIL]: { status: 'suppressed' } },
      });

      await fire(db as any);

      const written = subscriberWrite(db)!.data;
      expect(written.status).toBe('active');
      expect(written.recovered_from_status).toBe('suppressed');
    },
  );
});

// ─────────────────────────────────────────────────────────────
// Structural: no call site may go back to status-only
// ─────────────────────────────────────────────────────────────

describe('every recovery call site hands over the document, not just the status', () => {
  const PROVIDER_FILES = [
    'functions/src/newsletterMailgunWebhookCore.js',
    'functions/src/newsletterMailerooWebhookCore.js',
    'functions/src/newsletterMailjetWebhookCore.js',
    'functions/src/newsletterMailtrapWebhookCore.js',
    'functions/src/newsletterResendWebhookCore.js',
  ];

  it.each(PROVIDER_FILES)('%s passes `subscriber:` at every recovery/status decision', (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const decisions = (src.match(/positiveEvent(?:Recovery|Status)Fields\(\{/g) || []).length;
    const handovers = (src.match(/^\s*subscriber: current(?:Data)?,$/gm) || []).length;
    expect(decisions, `${file}: expected both branches to take a decision`).toBe(2);
    expect(handovers, `${file}: a decision is still made from \`status\` alone`).toBe(decisions);
  });

  it('the decision module reads the stamp, not only the status', () => {
    const src = readFileSync(
      new URL('../functions/src/lib/subscriberReactivation.js', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).toMatch(/isNewsletterOptOutBinding/);
    // Both decisions refuse on the stamp, not just the narrower one: dropping
    // the check from `positiveEventStatusFields` alone would restore the
    // `{ status: 'active' }` fall-through for every stamped `pending` doc.
    const refusals = src.match(/if \(hasBindingOptOutStamp\(subscriber\)\) return \{\};/g) || [];
    expect(refusals.length, 'a decision function stopped refusing on the stamp').toBe(2);
  });
});
