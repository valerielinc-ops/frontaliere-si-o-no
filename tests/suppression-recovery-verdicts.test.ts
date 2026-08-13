/**
 * Structural guard for the suppression-recovery rule.
 *
 * A subscriber's `status` gates every send. Two mirrored code paths inside the
 * same five `functions/src/newsletter*WebhookCore.js` files used to decide,
 * independently and in OPPOSITE directions, whether a positive event
 * (delivered/open/click) may clear it:
 *
 *  - the newsletter branch was too NARROW — it cleared only an exact
 *    `'inactive'` and explicitly refused `'bounced'`, so a subscriber flipped
 *    to `bounced` by a reputation/soft signal could never come back. That is a
 *    ONE-WAY DOOR: once suppressed we stop sending, so the delivered event that
 *    would clear the state can no longer arrive. 505 of 8.487 addresses were
 *    stuck that way in production (453 confirmed signups), every recovery so
 *    far a hand-run script.
 *  - the job-alert branch was too BROAD — an unconditional
 *    `topUpdate.status = 'active'` that would overwrite `'complained'`, a
 *    human's spam complaint, with a machine's inference.
 *
 * The rule now lives in ONE place (functions/src/lib/subscriberReactivation.js)
 * and this file makes the class of bug hard to reintroduce:
 *
 *  1. Every status in NEWSLETTER_EXCLUDED_STATUSES ∪ JOB_ALERT_EXCLUDED_STATUSES
 *     must carry an explicit, declared verdict here. The test is driven off the
 *     exported Sets, so adding a status to a suppression set WITHOUT declaring
 *     what a positive event does to it fails this file — nobody gets to leave
 *     the question open again.
 *  2. Human-declared states are never cleared, in either direction.
 *  3. No provider file may reintroduce its own local status decision.
 */
import { describe, expect, it } from 'vitest';

import {
  NEWSLETTER_EXCLUDED_STATUSES,
  JOB_ALERT_EXCLUDED_STATUSES,
} from '../services/emailSuppression.mjs';
import {
  positiveEventRecoveryFields,
  isTerminalSuppression,
  POSITIVE_RECOVERY_EVENTS,
  MACHINE_INFERRED_SUPPRESSIONS,
  HUMAN_DECLARED_SUPPRESSIONS,
} from '../functions/src/lib/subscriberReactivation.js';

import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';

// ── The declared verdicts ────────────────────────────────────
//
// `recovers`            — a positive event CLEARS it (machine inference, disproved).
// `recovers-unless-hard`— clears, except when `bounce_severity === 'hard'`.
// `terminal`            — a positive event NEVER clears it (human decision).
type Verdict = 'recovers' | 'recovers-unless-hard' | 'terminal';

const VERDICTS: Record<string, { verdict: Verdict; because: string }> = {
  inactive: {
    verdict: 'recovers',
    because: 'our own sunset of a never-engager (scripts/lib/subscriberSunset.mjs) — a machine guess, and engagement disproves it',
  },
  suppressed: {
    verdict: 'recovers',
    because: 'a provider suppression list — a third-party machine inference; a delivery to the same address disproves it',
  },
  bounced: {
    verdict: 'recovers-unless-hard',
    because: 'a soft/reputation reject (or a pre-classifier legacy doc with no severity) is an inference; a hard bounce is a dead mailbox and is proof',
  },
  complained: {
    verdict: 'terminal',
    because: 'a human pressed "this is spam" — consent withdrawn, no delivery signal overrides it',
  },
  unsubscribed: {
    verdict: 'terminal',
    because: 'a human opted out — consent withdrawn, no delivery signal overrides it',
  },
  expired: {
    verdict: 'terminal',
    because:
      'three confirmation requests, one per day, unanswered (#5692) — the silence IS the answer, and there is no machine inference here for a delivery to disprove. An `open` on the third unanswered confirmation email must not stand in for the click it asks for; only a fresh signup restarts the cycle',
  },
};

const ALL_SUPPRESSED_STATUSES = [
  ...new Set([...NEWSLETTER_EXCLUDED_STATUSES, ...JOB_ALERT_EXCLUDED_STATUSES]),
].sort();

describe('every suppression status has a declared recovery verdict', () => {
  it('leaves no status in the suppression sets undeclared', () => {
    const undeclared = ALL_SUPPRESSED_STATUSES.filter((s) => !VERDICTS[s]);
    // If this fails, a status was added to NEWSLETTER_EXCLUDED_STATUSES or
    // JOB_ALERT_EXCLUDED_STATUSES without anyone deciding whether a
    // delivered/open/click may clear it. Decide, then add it to VERDICTS above.
    expect(undeclared, `undeclared suppression statuses: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('declares no verdict for a status that is not actually a suppression', () => {
    const stale = Object.keys(VERDICTS).filter((s) => !ALL_SUPPRESSED_STATUSES.includes(s));
    expect(stale, `verdicts for non-suppression statuses: ${stale.join(', ')}`).toEqual([]);
  });

  it.each(ALL_SUPPRESSED_STATUSES)('status %s behaves as declared, for every positive event', (status) => {
    const { verdict } = VERDICTS[status];

    for (const event of POSITIVE_RECOVERY_EVENTS) {
      const softFields = positiveEventRecoveryFields({ currentStatus: status, bounceSeverity: 'soft', event });
      const absentFields = positiveEventRecoveryFields({ currentStatus: status, bounceSeverity: undefined, event });
      const hardFields = positiveEventRecoveryFields({ currentStatus: status, bounceSeverity: 'hard', event });

      if (verdict === 'terminal') {
        expect(softFields, `${status} + ${event}`).toEqual({});
        expect(absentFields, `${status} + ${event}`).toEqual({});
        expect(hardFields, `${status} + ${event}`).toEqual({});
        expect(isTerminalSuppression(status, undefined)).toBe(true);
        continue;
      }

      // Recovering verdicts: the cleared state is stamped and attributed.
      expect(softFields.status, `${status} + ${event}`).toBe('active');
      expect(absentFields.status, `${status} + ${event}`).toBe('active');
      expect(softFields.recovered_from_status).toBe(status);
      expect(softFields.recovered_by_event).toBe(event);
      expect(softFields.reactivated_at).toBeTruthy();

      if (verdict === 'recovers-unless-hard') {
        expect(hardFields, `${status} + ${event} + hard severity`).toEqual({});
        expect(isTerminalSuppression(status, 'hard')).toBe(true);
      } else {
        // Severity is a bounce-only field — it must not gate a non-bounce status.
        expect(hardFields.status, `${status} + ${event} + stray hard severity`).toBe('active');
      }
    }
  });
});

describe('the two suppression families are disjoint and complete', () => {
  it('classifies every suppression status as either machine-inferred or human-declared', () => {
    for (const status of ALL_SUPPRESSED_STATUSES) {
      const machine = MACHINE_INFERRED_SUPPRESSIONS.has(status);
      const human = HUMAN_DECLARED_SUPPRESSIONS.has(status);
      expect(machine || human, `${status} belongs to neither family`).toBe(true);
      expect(machine && human, `${status} belongs to both families`).toBe(false);
    }
  });
});

describe('human-declared states are never cleared by a delivery signal', () => {
  it.each(['complained', 'unsubscribed'])('never clears %s, on any positive event or severity', (status) => {
    for (const event of POSITIVE_RECOVERY_EVENTS) {
      for (const severity of ['hard', 'soft', undefined, null, '']) {
        expect(
          positiveEventRecoveryFields({ currentStatus: status, bounceSeverity: severity, event }),
          `${status} must survive ${event} (severity=${String(severity)})`,
        ).toEqual({});
      }
    }
  });

  it('is case- and whitespace-insensitive (Firestore values are not normalized on read)', () => {
    expect(positiveEventRecoveryFields({ currentStatus: '  COMPLAINED ', event: 'open' })).toEqual({});
    expect(positiveEventRecoveryFields({ currentStatus: 'Unsubscribed', event: 'delivered' })).toEqual({});
    expect(positiveEventRecoveryFields({ currentStatus: ' Inactive ', event: 'click' }).status).toBe('active');
  });
});

describe('bounced recovers only when the bounce is not proven permanent', () => {
  it('never clears a hard bounce', () => {
    expect(positiveEventRecoveryFields({ currentStatus: 'bounced', bounceSeverity: 'hard', event: 'delivered' })).toEqual({});
  });

  it('clears a soft bounce on a delivered event, with a bounce-specific audit stamp', () => {
    const fields = positiveEventRecoveryFields({ currentStatus: 'bounced', bounceSeverity: 'soft', event: 'delivered' });
    expect(fields.status).toBe('active');
    expect(fields.bounce_reactivated_at).toBeTruthy();
    expect(fields.recovered_from_status).toBe('bounced');
    expect(fields.recovered_by_event).toBe('delivered');
    expect(fields.soft_bounce_count).toBe(0);
  });

  it('clears a bounce with NO recorded severity — the pre-classifier legacy docs, the bulk of the stuck 505', () => {
    const fields = positiveEventRecoveryFields({ currentStatus: 'bounced', event: 'delivered' });
    expect(fields.status).toBe('active');
    expect(fields.bounce_reactivated_at).toBeTruthy();
  });
});

describe('only a positive event recovers anything', () => {
  it.each(['send', 'bounce', 'complaint', 'unsubscribed', 'failed', 'delivery_delayed'])(
    'event %s never recovers a suppressed subscriber',
    (event) => {
      for (const status of ALL_SUPPRESSED_STATUSES) {
        expect(positiveEventRecoveryFields({ currentStatus: status, event })).toEqual({});
      }
    },
  );

  it('leaves a healthy subscriber untouched (nothing to recover)', () => {
    for (const status of ['active', 'confirmed', 'pending', '', null, undefined]) {
      expect(positiveEventRecoveryFields({ currentStatus: status as string, event: 'delivered' })).toEqual({});
    }
  });
});

// ── The job-alert branch, end to end, on all 5 providers ─────

function createFakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string): any => ({
    doc: (docId: string) => {
      const docRef: any = {
        set: async (data: Record<string, unknown>) => {
          sets.push({ collection: name, docId, data });
        },
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
            add: async (data: Record<string, unknown>) => {
              adds.push({ collection: subPath, data });
            },
            // refreshPreferredSendHour queries the `events` subcollection.
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

  return {
    collection(name: string) { return makeCollection(name); },
    __sets: sets,
    __adds: adds,
  };
}

const JOB_ALERT_EMAIL = 'seeker@example.com';

/** Fires ONE job-alert `delivered` event per provider, on a pre-seeded doc. */
const JOB_ALERT_DELIVERIES: Array<[string, (db: any) => Promise<unknown>]> = [
  ['mailgun', (db) => persistMailgunEvent(db, {
    event: 'delivered', recipient: JOB_ALERT_EMAIL, timestamp: 1700000000, tags: ['job-alert'],
  })],
  ['mailtrap', (db) => persistMailtrapEvent(db, {
    event: 'delivery', email: JOB_ALERT_EMAIL, timestamp: 1700000000, category: 'job-alert',
  })],
  // Mailjet has no `delivered` event at all (mapMailjetEvent maps `sent` → send),
  // so `open` is its cheapest positive signal.
  ['mailjet', (db) => persistMailjetEvent(db, {
    event: 'open', email: JOB_ALERT_EMAIL, time: 1700000000, CustomID: 'job-alert',
  })],
  ['maileroo', (db) => persistMailerooEvent(db, {
    event_type: 'delivered',
    message_reference_id: 'ref_ja',
    event_data: { to: JOB_ALERT_EMAIL },
  })],
  ['resend', (db) => applyResendWebhookEvent({
    type: 'email.delivered',
    data: { email: JOB_ALERT_EMAIL, email_id: 'msg_ja', tags: [{ name: 'type', value: 'job-alert' }] },
  }, { db })],
];

// Maileroo resolves the recipient from a lookup record, not from the payload.
const MAILEROO_REF = {
  'newsletter_subscribers/_meta_/maileroo_refs': {
    ref_ja: { email: JOB_ALERT_EMAIL, is_job_alert: true },
  },
};

function jobAlertWrite(db: ReturnType<typeof createFakeDb>) {
  return db.__sets.find((s) => s.collection === 'job_alert_subscribers' && s.docId === JOB_ALERT_EMAIL);
}

describe('job-alert branch: a positive event never overwrites a human-declared status', () => {
  it.each(JOB_ALERT_DELIVERIES)('%s leaves a complained job-alert subscriber complained', async (_provider, fire) => {
    const db = createFakeDb({
      ...MAILEROO_REF,
      job_alert_subscribers: { [JOB_ALERT_EMAIL]: { status: 'complained' } },
    });

    await fire(db as any);

    // Before the fix this branch ended with an unconditional
    // `topUpdate.status = 'active'`, silently un-doing the complaint.
    expect(jobAlertWrite(db)!.data.status).toBeUndefined();
  });

  it.each(JOB_ALERT_DELIVERIES)('%s leaves a hard-bounced job-alert subscriber bounced', async (_provider, fire) => {
    const db = createFakeDb({
      ...MAILEROO_REF,
      job_alert_subscribers: { [JOB_ALERT_EMAIL]: { status: 'bounced', bounce_severity: 'hard' } },
    });

    await fire(db as any);

    expect(jobAlertWrite(db)!.data.status).toBeUndefined();
  });

  it.each(JOB_ALERT_DELIVERIES)('%s recovers a soft-bounced job-alert subscriber', async (_provider, fire) => {
    const db = createFakeDb({
      ...MAILEROO_REF,
      job_alert_subscribers: { [JOB_ALERT_EMAIL]: { status: 'bounced', bounce_severity: 'soft' } },
    });

    await fire(db as any);

    const written = jobAlertWrite(db)!.data;
    expect(written.status).toBe('active');
    expect(written.recovered_from_status).toBe('bounced');
    expect(written.bounce_reactivated_at).toBeTruthy();
  });

  it.each(JOB_ALERT_DELIVERIES)('%s still promotes a plain healthy subscriber to active', async (_provider, fire) => {
    const db = createFakeDb({
      ...MAILEROO_REF,
      job_alert_subscribers: { [JOB_ALERT_EMAIL]: { status: 'pending' } },
    });

    await fire(db as any);

    expect(jobAlertWrite(db)!.data.status).toBe('active');
  });
});

// ── No provider may grow its own local status decision again ──

describe('no provider webhook core reintroduces a local status decision', async () => {
  const { readFileSync } = await import('node:fs');
  const PROVIDER_FILES = [
    'functions/src/newsletterMailgunWebhookCore.js',
    'functions/src/newsletterMailerooWebhookCore.js',
    'functions/src/newsletterMailjetWebhookCore.js',
    'functions/src/newsletterMailtrapWebhookCore.js',
    'functions/src/newsletterResendWebhookCore.js',
  ];

  it.each(PROVIDER_FILES)('%s routes its recovery through the shared decision function', (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

    // The newsletter branch must consult the recovery decision...
    expect(
      src.includes('positiveEventRecoveryFields('),
      `${file}: newsletter branch must call positiveEventRecoveryFields`,
    ).toBe(true);
    // ...and the job-alert branch the full status decision.
    expect(
      src.includes('positiveEventStatusFields('),
      `${file}: job-alert branch must call positiveEventStatusFields`,
    ).toBe(true);

    // Neither may flip `status` to 'active' on its own — that assignment,
    // applied unconditionally on delivered/open/click, IS the bug. Comments are
    // stripped first so the files stay free to quote the old line while
    // explaining why it is gone.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const localActiveAssign = code.match(/(?:topUpdate|subscriberUpdate|update)\.status\s*=\s*'active'/g) || [];
    expect(localActiveAssign, `${file} assigns status='active' locally instead of via the shared decision`).toEqual([]);
  });
});
