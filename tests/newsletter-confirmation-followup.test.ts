/**
 * tests/newsletter-confirmation-followup.test.ts
 *
 * THE INVARIANT: a double opt-in that is never answered ENDS, and it ends
 * without ever touching somebody who already answered it (#5692).
 *
 * Written against the lesson of #5764 rather than against the code: the last
 * four defects in this area were not hidden, they were UNSAMPLED. One survived
 * three issues written to close it, and when the coverage was finally added the
 * number of tests that had to be corrected was zero — every fixture in the file
 * used `status: 'unsubscribed'`, which takes the other branch. A green gate over
 * a population that excludes the broken case is indistinguishable from a gate
 * that works.
 *
 * So each block below names the document shape it exists for, and the shapes
 * are the ones production actually holds. Measured 2026-08-13 over 8.670
 * documents:
 *
 *   pending                                    1.498   (+12/day)
 *     already carrying `confirmed_at`            848   ← the trap
 *     never confirmed, confirmation email sent    619
 *     never confirmed, never asked                 31   (none in the last 30 days)
 *     carrying an opt-out stamp anyway              3
 *     with no creation stamp at all                 1
 *   pending older than 90 days                   487
 *
 * The 848 are `scripts/mailtrap-suppression-retry.mjs` writing
 * `status: 'pending', isActive: true` on a previously-confirmed address as a
 * deliverability re-probe: `pending` there means "re-probe me", not "never
 * consented" (services/subscriberConsent.mjs). A follow-up cycle that counted
 * `status === 'pending'` and stopped there would close 848 real subscriptions
 * and call it list hygiene. That fixture is first in this file for that reason.
 *
 * Every address here is on example.com (the repo is public).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'evt-1' }));
const getDocMock = vi.fn<(...args: unknown[]) => Promise<{ exists: () => boolean; data: () => any }>>();

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import {
  decideConfirmationFollowup,
  confirmationSendRefusal,
  confirmationAttemptsUsed,
  confirmationFirstSentAt,
  isConfirmationCycleSend,
  buildConfirmationExpiryFields,
  buildConfirmationSentFields,
  buildConfirmationSentEvent,
  MAX_CONFIRMATION_ATTEMPTS,
  MIN_ATTEMPT_INTERVAL_MS,
  CONFIRMATION_WINDOW_MS,
  CONFIRMATION_EXPIRED_STATUS,
  DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH,
} from '../functions/src/lib/confirmationFollowup.js';
import {
  CONFIRMATION_FRAMES,
  buildNewsletterConfirmationEmailHtml,
  confirmationEmailSubject,
  confirmationFrameForAttempt,
  confirmationReminderBanner,
  formatConfirmationDate,
} from '../functions/src/lib/confirmationEmailContent.js';
import { t } from '../functions/src/emailI18n.js';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES, isNewsletterExcluded } from '../services/emailSuppression.mjs';
import {
  isTerminalSuppression,
  positiveEventRecoveryFields,
  HUMAN_DECLARED_SUPPRESSIONS,
  MACHINE_INFERRED_SUPPRESSIONS,
} from '../functions/src/lib/subscriberReactivation.js';
import {
  planConfirmationFollowups,
  buildFollowupRequest,
  maskEmail,
  confirmationReturnPath,
} from '../scripts/newsletter-confirmation-followups.mjs';
import {
  planConfirmedStatusBackfill,
  applyConfirmedStatusBackfill,
  buildConfirmedStatusFields,
  confirmationProofSource,
  hasConfirmEvent,
  assessCohortDrift,
  CONFIRMED_STATUS,
  EXPECTED_REPAIR_COHORT,
} from '../scripts/newsletter-confirmed-status-backfill.mjs';
import { captureNewsletterSubscriber, upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { FUNCTIONS_BASE } from '@/services/functionsBase';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const EPOCH = Date.parse(DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH);
const ctx = { now: NOW, epochMs: EPOCH };

const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);
/** What the Admin SDK actually hands back for a timestamp field. */
const fsTimestamp = (iso: string) => ({ toDate: () => new Date(iso) });

/** A signup made after the epoch, which is the only population the rule covers. */
const pendingDoc = (overrides: Record<string, any> = {}) => ({
  email: 'p@example.com',
  status: 'pending',
  isActive: false,
  created_at: daysAgo(1),
  ...overrides,
});

describe('the 848 that must never be touched: `pending` WITH a confirmation stamp', () => {
  // THE SHAPE NOBODY SAMPLES. It is `pending`, it is old, it has zero
  // confirmation emails recorded — it looks exactly like the cohort this
  // feature exists for, and it is the opposite of it.
  it('never asks a re-probe to confirm, and never expires one, in either spelling', () => {
    for (const stamp of ['confirmed_at', 'confirmedAt']) {
      const reProbe = pendingDoc({
        [stamp]: daysAgo(200),
        isActive: true,
        suppressed_at: daysAgo(30),
        reactivated_at: daysAgo(29),
        created_at: daysAgo(1),
      });
      expect(decideConfirmationFollowup(reProbe, ctx)).toMatchObject({
        action: 'skip',
        reason: 'already-confirmed',
      });
    }
  });

  it('holds even at the cap, where the expiry would otherwise fire', () => {
    // The ordering matters, not just the rule: proof is asked BEFORE anything
    // counts attempts, so a re-probe that happens to carry three old
    // confirmation sends is still not a candidate for the terminal state.
    const reProbe = pendingDoc({
      confirmed_at: daysAgo(200),
      confirmation_attempts: MAX_CONFIRMATION_ATTEMPTS,
      confirmation_sent_at: daysAgo(9),
    });
    expect(decideConfirmationFollowup(reProbe, ctx).action).toBe('skip');
  });

  it('and the cap at the send point does not apply to them either', () => {
    // Same population, other enforcement point: `confirmationSendRefusal` is
    // what the Cloud Function asks. A re-probe is not in a confirmation cycle,
    // so its sends are not counted against three.
    const reProbe = { status: 'pending', confirmed_at: daysAgo(200), confirmation_attempts: 9 };
    expect(isConfirmationCycleSend({ data: reProbe })).toBe(false);
    expect(confirmationSendRefusal({ data: reProbe, purpose: undefined, now: NOW })).toBeNull();
  });
});

describe('the cadence: three requests, one per day, the first included', () => {
  it('asks a brand-new signup that has no record of any send at all', () => {
    // The 31 measured: `pending`, no `confirmation_sent_at`, no counter. Until
    // #5692 nothing in the codebase would ever ask them again.
    expect(decideConfirmationFollowup(pendingDoc({ created_at: hoursAgo(1) }), ctx)).toEqual({
      action: 'send',
      attempt: 1,
      attempts: 0,
      reason: 'first-ask',
    });
  });

  it('walks 1 → 2 → 3 a day apart', () => {
    for (const used of [1, 2]) {
      const doc = pendingDoc({
        confirmation_attempts: used,
        confirmation_sent_at: hoursAgo(25),
        confirmation_cycle_started_at: daysAgo(used),
      });
      expect(decideConfirmationFollowup(doc, ctx)).toEqual({
        action: 'send',
        attempt: used + 1,
        attempts: used,
        reason: 'reminder',
      });
    }
  });

  it('refuses a second request the same day — the cadence, not the 1-hour cooldown', () => {
    // The distinction the issue insists on: the cooldown in
    // newsletterConfirmationEmail.js protects against a double click and stays
    // where it is; this is a separate, much longer floor that governs reminders.
    const doc = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(2) });
    expect(decideConfirmationFollowup(doc, ctx)).toMatchObject({ action: 'skip', reason: 'too-soon' });
  });

  it('tolerates cron jitter: 20h counts as "the next day", 19h does not', () => {
    const at = (h: number) => pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(h) });
    expect(MIN_ATTEMPT_INTERVAL_MS).toBe(20 * 60 * 60 * 1000);
    expect(decideConfirmationFollowup(at(20), ctx).action).toBe('send');
    expect(decideConfirmationFollowup(at(19), ctx)).toMatchObject({ action: 'skip', reason: 'too-soon' });
  });

  it('never asks a fourth time', () => {
    const exhausted = pendingDoc({
      confirmation_attempts: MAX_CONFIRMATION_ATTEMPTS,
      confirmation_sent_at: hoursAgo(25),
    });
    expect(decideConfirmationFollowup(exhausted, ctx)).toEqual({
      action: 'expire',
      attempts: 3,
      reason: 'attempts-exhausted',
    });
  });

  it('gives the third request its own day before closing the record', () => {
    const justAsked = pendingDoc({
      confirmation_attempts: MAX_CONFIRMATION_ATTEMPTS,
      confirmation_sent_at: hoursAgo(3),
    });
    expect(decideConfirmationFollowup(justAsked, ctx)).toMatchObject({
      action: 'skip',
      reason: 'awaiting-last-chance',
    });
  });
});

describe('the counter, on documents written before the counter existed', () => {
  it('reads a send stamp as one attempt when there is no counter', () => {
    // Every `pending` document in production today is this shape: 619 of them
    // carry `confirmation_sent_at` and no `confirmation_attempts`. Counting
    // them from zero would give four requests, not three.
    expect(confirmationAttemptsUsed({ confirmation_sent_at: hoursAgo(30), created_at: daysAgo(2) })).toBe(1);
  });

  it('reads both spellings of both fields', () => {
    expect(confirmationAttemptsUsed({ confirmationAttempts: 2, createdAt: daysAgo(3) })).toBe(2);
    expect(confirmationAttemptsUsed({ confirmationSentAt: hoursAgo(30), createdAt: daysAgo(2) })).toBe(1);
  });

  it('decides the same way on a camelCase-only document', () => {
    // 458 documents in this collection carry only camelCase stamps (#5673).
    const camel = {
      email: 'camel@example.com',
      status: 'pending',
      createdAt: daysAgo(2),
      confirmationSentAt: hoursAgo(25),
      confirmationAttempts: 2,
    };
    expect(decideConfirmationFollowup(camel, ctx)).toEqual({
      action: 'send',
      attempt: 3,
      attempts: 2,
      reason: 'reminder',
    });
  });

  it('reads a Firestore Timestamp, an ISO string and an epoch number identically', () => {
    const iso = hoursAgo(25);
    const shapes = [iso, fsTimestamp(iso), new Date(iso), new Date(iso).getTime(), Math.floor(new Date(iso).getTime() / 1000)];
    for (const sent of shapes) {
      const doc = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: sent });
      expect(decideConfirmationFollowup(doc, ctx), `shape ${typeof sent}`).toMatchObject({
        action: 'send',
        attempt: 2,
      });
    }
  });
});

describe('the terminal state is terminal, and it is kept', () => {
  it('an already-`expired` document is skipped, not re-asked and not deleted', () => {
    const expired = pendingDoc({
      status: CONFIRMATION_EXPIRED_STATUS,
      confirmation_attempts: 3,
      confirmation_expired_at: daysAgo(2),
      confirmation_sent_at: daysAgo(3),
    });
    expect(decideConfirmationFollowup(expired, ctx)).toMatchObject({
      action: 'skip',
      reason: 'already-expired',
    });
  });

  it('the closing write preserves the record and says why it closed', () => {
    const fields = buildConfirmationExpiryFields(
      { action: 'expire', attempts: 3, reason: 'attempts-exhausted' } as any,
      '2026-09-01T12:00:00.000Z',
    );
    expect(fields.status).toBe('expired');
    expect(fields.isActive).toBe(false);
    expect(fields.active).toBe(false);
    expect(fields.confirmation_attempts).toBe(3);
    expect(fields.confirmation_expired_reason).toBe('attempts-exhausted');
    // Both spellings, like every other stamp on this document (#5673).
    expect(fields.confirmation_expired_at).toBe('2026-09-01T12:00:00.000Z');
    expect(fields.confirmationExpiredAt).toBe('2026-09-01T12:00:00.000Z');
    // Nothing is removed: no field is a delete sentinel, and the address,
    // consent text and history are untouched by construction.
    expect(Object.values(fields).some((v) => String(v).includes('delete'))).toBe(false);
  });

  it('no channel mails an `expired` address, and no delivery signal revives it', () => {
    expect(NEWSLETTER_EXCLUDED_STATUSES.has('expired')).toBe(true);
    expect(isNewsletterExcluded('expired')).toBe(true);
    // The half that is easy to forget: the win-back and the sunset are
    // deliberately NOT gated on confirmation proof (they exist to reach people
    // the ordinary campaigns may not), so the status vocabulary is the only
    // thing standing between them and an address we recorded as finished.
    expect(isTerminalSuppression('expired', undefined)).toBe(true);
    for (const event of ['delivered', 'open', 'click']) {
      expect(positiveEventRecoveryFields({ currentStatus: 'expired', event })).toEqual({});
    }
    expect(HUMAN_DECLARED_SUPPRESSIONS.has('expired')).toBe(true);
    expect(MACHINE_INFERRED_SUPPRESSIONS.has('expired')).toBe(false);
  });
});

describe('the four ways a cycle stops early', () => {
  it('stops on a recorded opt-out, including the camelCase-only spelling', () => {
    const optedOut = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(30), unsubscribedAt: hoursAgo(20) });
    expect(decideConfirmationFollowup(optedOut, ctx)).toMatchObject({ action: 'skip', reason: 'opt-out' });
  });

  it('stops on a hard bounce or a complaint recorded on a still-`pending` document', () => {
    // Issue rule 4: a bounce on the first request makes the second and third
    // guaranteed failed deliveries.
    const hard = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(30), bounce_severity: 'hard' });
    expect(decideConfirmationFollowup(hard, ctx)).toMatchObject({ action: 'skip', reason: 'address-signal' });

    const complained = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(30), last_complained_at: hoursAgo(25) });
    expect(decideConfirmationFollowup(complained, ctx)).toMatchObject({ action: 'skip', reason: 'address-signal' });
  });

  it('a soft bounce does NOT stop it — the next day\'s request is the right answer to one', () => {
    const soft = pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(30), bounce_severity: 'soft' });
    expect(decideConfirmationFollowup(soft, ctx).action).toBe('send');
  });

  it('leaves every non-`pending` status alone', () => {
    for (const status of ['confirmed', 'unsubscribed', 'bounced', 'complained', 'suppressed', 'inactive', 'subscribed', '']) {
      expect(decideConfirmationFollowup(pendingDoc({ status }), ctx), status).toMatchObject({
        action: 'skip',
        reason: 'not-pending',
      });
    }
  });
});

describe('«vale solo per le iscrizioni future» is a property of the code, not of the cron', () => {
  it('never touches a document created before the epoch, whatever state it is in', () => {
    const backlog = pendingDoc({
      created_at: '2026-05-01T00:00:00.000Z',
      confirmation_attempts: MAX_CONFIRMATION_ATTEMPTS,
      confirmation_sent_at: daysAgo(60),
    });
    expect(decideConfirmationFollowup(backlog, ctx)).toMatchObject({ action: 'skip', reason: 'backlog' });
  });

  it('the epoch is a constant, so the same document gets the same answer on every run', () => {
    // A default of "now" would make eligibility depend on the hour the cron
    // started. The 1.498 backlog documents are all on the far side of this date.
    expect(DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH).toBe('2026-08-14T00:00:00.000Z');
    const doc = pendingDoc({ created_at: '2026-08-13T23:59:59.000Z', confirmation_attempts: 3, confirmation_sent_at: daysAgo(5) });
    for (const now of [NOW, NOW + 30 * 24 * 3600_000, NOW + 365 * 24 * 3600_000]) {
      expect(decideConfirmationFollowup(doc, { now, epochMs: EPOCH })).toMatchObject({ reason: 'backlog' });
    }
  });

  it('fails closed on a document whose age cannot be established', () => {
    // One production document is in this state. Guessing would write a terminal
    // status on somebody the rule may not even cover; skipping only leaves it
    // countable where it already is.
    const undated = { email: 'undated@example.com', status: 'pending', confirmation_attempts: 3, confirmation_sent_at: daysAgo(9) };
    expect(decideConfirmationFollowup(undated, ctx)).toMatchObject({
      action: 'skip',
      reason: 'no-creation-stamp',
    });
  });
});

describe('the window: a record closes even while the reminder texts do not exist', () => {
  it('closes a cycle that ran out of days rather than out of requests', () => {
    // Today only the first request is wired — the two reminders are the
    // owner's text to write — so without this rule a record would sit at one
    // attempt forever and the ~12/day accumulation would continue behind a cap
    // that never fills.
    const stalled = pendingDoc({
      created_at: daysAgo(5),
      confirmation_cycle_started_at: daysAgo(5),
      confirmation_attempts: 1,
      confirmation_sent_at: daysAgo(5),
    });
    expect(decideConfirmationFollowup(stalled, ctx)).toEqual({
      action: 'expire',
      attempts: 1,
      reason: 'window-elapsed',
    });
  });

  it('the two reasons stay countable, so «expired after one request» is measurable', () => {
    expect(CONFIRMATION_WINDOW_MS).toBe((MAX_CONFIRMATION_ATTEMPTS + 1) * 24 * 60 * 60 * 1000);
    const onTime = pendingDoc({
      created_at: daysAgo(3),
      confirmation_cycle_started_at: daysAgo(3),
      confirmation_attempts: MAX_CONFIRMATION_ATTEMPTS,
      confirmation_sent_at: hoursAgo(25),
    });
    expect(decideConfirmationFollowup(onTime, ctx).reason).toBe('attempts-exhausted');
  });

  it('does not close a cycle still inside its window', () => {
    const young = pendingDoc({
      created_at: daysAgo(2),
      confirmation_cycle_started_at: daysAgo(2),
      confirmation_attempts: 1,
      confirmation_sent_at: hoursAgo(25),
    });
    expect(decideConfirmationFollowup(young, ctx).action).toBe('send');
  });
});

describe('a second signup after `expired` gets three requests, not zero', () => {
  // The failure mode of a terminal state that is KEPT rather than deleted, and
  // the one nothing else in this repo would have caught: the counter survives
  // the previous cycle, so without an explicit restart the returning
  // subscriber is capped before their first email.
  const restarted = {
    email: 'again@example.com',
    status: 'pending',
    created_at: daysAgo(12),
    confirmation_attempts: 0,
    confirmation_cycle_started_at: hoursAgo(1),
    // The previous cycle's residue, deliberately not deleted.
    confirmation_sent_at: daysAgo(9),
    confirmation_first_sent_at: daysAgo(12),
    confirmation_expired_at: daysAgo(8),
    confirmation_expired_reason: 'attempts-exhausted',
  };

  it('does not count the previous cycle\'s stamp against the new one', () => {
    expect(confirmationAttemptsUsed(restarted)).toBe(0);
  });

  it('asks them a first time', () => {
    expect(decideConfirmationFollowup(restarted, ctx)).toMatchObject({ action: 'send', attempt: 1, reason: 'first-ask' });
  });

  it('and the send point agrees — the cap is not still armed from last time', () => {
    expect(confirmationSendRefusal({ data: restarted, purpose: undefined, now: NOW })).toBeNull();
  });
});

describe('the cap lives at the send point, where every caller passes', () => {
  it('refuses a fourth request', () => {
    const data = { status: 'pending', confirmation_attempts: 3, confirmation_sent_at: daysAgo(2), created_at: daysAgo(4) };
    expect(confirmationSendRefusal({ data, purpose: undefined, now: NOW })).toEqual({
      error: 'confirmation_attempts_exhausted',
      attempts: 3,
    });
  });

  it('never locks a confirmed subscriber out of their own passwordless login link', () => {
    // `purpose: 'login'` sends the same link as a sign-in link to somebody who
    // HAS confirmed. Capping it at three would lock them out of the preference
    // centre after three sign-ins — a cap on the wrong verb.
    const confirmed = { status: 'confirmed', confirmed_at: daysAgo(400), confirmation_attempts: 12 };
    expect(confirmationSendRefusal({ data: confirmed, purpose: 'login', now: NOW })).toBeNull();
    expect(isConfirmationCycleSend({ data: confirmed, purpose: 'login' })).toBe(false);
  });

  it('holds a declared follow-up to the one-per-day floor without removing the cooldown', () => {
    const data = { status: 'pending', confirmation_attempts: 1, confirmation_sent_at: hoursAgo(2), created_at: daysAgo(1) };
    expect(confirmationSendRefusal({ data, purpose: 'followup', now: NOW })).toMatchObject({ error: 'followup_too_soon' });
    // The same document, a day later.
    const later = { ...data, confirmation_sent_at: hoursAgo(21) };
    expect(confirmationSendRefusal({ data: later, purpose: 'followup', now: NOW })).toBeNull();
  });

  it('the ordinary signup path is unchanged: no purpose, no attempts, no refusal', () => {
    expect(confirmationSendRefusal({ data: { status: 'pending' }, purpose: undefined, now: NOW })).toBeNull();
  });

  it('the Cloud Function actually asks — and still keeps its own 1-hour cooldown', () => {
    // A source scan, because driving sendNewsletterConfirmationEmail means
    // standing up the provider cascade, the token policy and Remote Config.
    // What it proves is what a reviewer needs: the refusal is consulted before
    // any mail is composed, and the cooldown was not "simplified away" while
    // the follow-up path was being added.
    const src = read('functions/src/newsletterConfirmationEmail.js');
    expect(src).toMatch(/confirmationSendRefusal\(\{\s*data,\s*purpose,\s*now\s*\}\)/);
    expect(src).toMatch(/CONFIRMATION_COOLDOWN_MS/);
    expect(src).toMatch(/cooldown_active/);
    // Re-pointed by the same PR that wired the reminders: the increment moved
    // into buildConfirmationSentFields, which the follow-up runner shares. What
    // this line asserts is unchanged — the counter is written where the mail
    // actually leaves — and the arithmetic itself is asserted on the builder.
    expect(src).toMatch(/buildConfirmationSentFields\(\{/);
    expect(src.indexOf('confirmationSendRefusal({')).toBeLessThan(src.indexOf('sendEmailCascade(['));
  });

  it('the frame the reader sees comes from the counter the cap reads', () => {
    // Two facts that must never disagree: the email that says "this is the last
    // reminder" is the same event that writes `confirmation_attempts: 3`. They
    // are computed from one pair of values, above the send, and used by both.
    const src = read('functions/src/newsletterConfirmationEmail.js');
    const attemptsAt = src.indexOf('const attemptsBefore = confirmationAttemptsUsed(data)');
    expect(attemptsAt).toBeGreaterThan(-1);
    expect(attemptsAt).toBeLessThan(src.indexOf('sendEmailCascade(['));
    expect(src).toMatch(/confirmationFrameForAttempt\(attemptsBefore \+ 1\)/);
    // A login link is not a cycle send, so it never gets a reminder frame — an
    // already-confirmed subscriber signing in must not be told they are about to
    // stop hearing from us.
    expect(src).toMatch(/isCycleSend \? confirmationFrameForAttempt\(attemptsBefore \+ 1\) : CONFIRMATION_FRAMES\.FIRST/);
  });
});

describe('the runner plans, it does not remember', () => {
  const docs = [
    { id: 'fresh@example.com', data: pendingDoc({ created_at: hoursAgo(1) }) },
    { id: 'due@example.com', data: pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(25) }) },
    { id: 'done@example.com', data: pendingDoc({ confirmation_attempts: 3, confirmation_sent_at: hoursAgo(30) }) },
    { id: 'reprobe@example.com', data: pendingDoc({ confirmed_at: daysAgo(200) }) },
    { id: 'old@example.com', data: pendingDoc({ created_at: '2026-04-01T00:00:00.000Z' }) },
    { id: 'gone@example.com', data: pendingDoc({ status: 'unsubscribed' }) },
  ];

  it('groups every document into exactly one bucket, with the denominator kept', () => {
    const plan = planConfirmationFollowups(docs, ctx);
    expect(plan.total).toBe(6);
    expect(plan.send.map((s: any) => s.id).sort()).toEqual(['due@example.com', 'fresh@example.com']);
    expect(plan.expire.map((s: any) => s.id)).toEqual(['done@example.com']);
    expect(plan.skipped).toEqual({ 'already-confirmed': 1, backlog: 1, 'not-pending': 1 });
    const skipped = (Object.values(plan.skipped) as number[]).reduce((a, b) => a + b, 0);
    const bucketed = plan.send.length + plan.expire.length + skipped;
    expect(bucketed).toBe(plan.total);
  });

  it('answers from the document as it is now, so yesterday\'s plan cannot mail today\'s confirmer', () => {
    // Issue rule 6, as behaviour rather than as a comment: the same input
    // document, plus the confirmation that arrived overnight, changes bucket.
    const due = docs[1];
    expect(planConfirmationFollowups([due], ctx).send).toHaveLength(1);
    const confirmedOvernight = { ...due, data: { ...due.data, confirmed_at: hoursAgo(1) } };
    expect(planConfirmationFollowups([confirmedOvernight], ctx).send).toHaveLength(0);
  });

  it('masks addresses by default — this population is the one we may print least', () => {
    expect(maskEmail('mario.rossi@example.com')).toBe('m***@example.com');
    expect(maskEmail('')).toBe('***');
  });

  /**
   * The question the last four defects in this area failed: which shapes has
   * the SEND path never been shown?
   *
   * Until this PR the runner could not send, so every one of these was a shape
   * that had never been tested against an outbound message — only against a
   * decision printed to a log. `plan.send` is the only queue the cascade is
   * handed, so a document absent from it cannot be mailed by construction, and
   * that is what each row asserts.
   */
  const NEVER_MAILED: Array<[string, Record<string, any>, string]> = [
    ['`pending` with confirmed_at — the 842 re-probes', pendingDoc({ confirmed_at: daysAgo(200), isActive: true }), 'already-confirmed'],
    ['…in the camelCase spelling', pendingDoc({ confirmedAt: daysAgo(200) }), 'already-confirmed'],
    ['at the third attempt (it is expired, not asked a fourth time)', pendingDoc({ confirmation_attempts: 3, confirmation_sent_at: hoursAgo(30) }), null as any],
    ['already `expired` — terminal is terminal', pendingDoc({ status: CONFIRMATION_EXPIRED_STATUS, confirmation_attempts: 3 }), 'already-expired'],
    ['an opt-out that arrived between two reminders', pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(25), unsubscribedAt: daysAgo(1) }), 'opt-out'],
    ['a camelCase-only timestamp on a hard-bounced address', pendingDoc({ confirmationSentAt: hoursAgo(25), confirmationAttempts: 1, bounce_severity: 'hard' }), 'address-signal'],
    ['no creation stamp at all — fail-closed', { email: 'x@example.com', status: 'pending' }, 'no-creation-stamp'],
    ['created before the epoch', pendingDoc({ created_at: '2026-04-01T00:00:00.000Z' }), 'backlog'],
    ['asked less than 20h ago', pendingDoc({ confirmation_attempts: 1, confirmation_sent_at: hoursAgo(19) }), 'too-soon'],
    ['no longer `pending`', pendingDoc({ status: 'unsubscribed' }), 'not-pending'],
  ];

  it.each(NEVER_MAILED)('no message is composed for %s', (_label, data, reason) => {
    const plan = planConfirmationFollowups([{ id: 'x@example.com', data }], ctx);
    expect(plan.send).toEqual([]);
    if (reason) expect(plan.skipped).toEqual({ [reason]: 1 });
    // The third-attempt row is the one that is not skipped: it closes.
    else expect(plan.expire).toHaveLength(1);
  });

  it('counts the never-asked backlog apart, instead of folding it into `backlog`', () => {
    // The 31. `pending`, created before the epoch, no proof and no request ever
    // recorded — people who submitted a form and were written to zero times.
    // They are backlog like the other 480, and the difference matters: what they
    // are owed is a FIRST confirmation email, which is a different act. The
    // number has to survive the summary for anyone to decide about them.
    const backlog = [
      { id: 'never@example.com', data: pendingDoc({ created_at: '2026-04-01T00:00:00.000Z' }) },
      { id: 'asked@example.com', data: pendingDoc({ created_at: '2026-04-01T00:00:00.000Z', confirmation_sent_at: '2026-04-02T00:00:00.000Z' }) },
      { id: 'reprobe@example.com', data: pendingDoc({ created_at: '2026-04-01T00:00:00.000Z', confirmed_at: daysAgo(200) }) },
    ];
    const plan = planConfirmationFollowups(backlog, ctx);
    expect(plan.send).toEqual([]);
    expect(plan.neverAskedBacklog).toBe(1);
    // A re-probe is `already-confirmed`, not backlog, and must never be counted
    // among the people waiting to be asked for the first time.
    expect(plan.skipped).toEqual({ backlog: 2, 'already-confirmed': 1 });
  });

  it('a post-epoch signup that was never asked gets the FIRST email, not a reminder', () => {
    // The same "never asked" shape on the other side of the epoch: this one IS
    // in scope, and what it is owed is request #1 with no banner on it.
    const item = { id: 'new@example.com', data: pendingDoc({ created_at: hoursAgo(2) }) };
    const [due] = planConfirmationFollowups([item], ctx).send;
    expect(due.decision).toMatchObject({ action: 'send', attempt: 1, reason: 'first-ask' });
    const req = buildFollowupRequest(due, { secret: 'test-secret' });
    expect(req.meta.frame).toBe(CONFIRMATION_FRAMES.FIRST);
    expect(req.payload.subject).toBe('Conferma la tua iscrizione alla newsletter – Frontaliere Ticino');
    expect(req.payload.html).not.toContain('Ti avevamo scritto');
  });

  it('sends through the shared cascade, in the open — the scan is the contract', () => {
    // This assertion replaces the tripwire that stood here while the copy did
    // not exist. It used to read `expect(code).not.toMatch(/sendEmailCascade/)`,
    // and its whole purpose was to force this review: the day the send was
    // wired, tests/helpers/senders.ts would find this file and both channel
    // gates would demand a verdict for it. They now have one — `consent-request`
    // in each — so what is left to assert is the shape of the wiring: the send
    // is visible to that scan, and it did not go around it.
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/sendEmailCascade\s*\(/);
    // No provider client of its own: everything goes through the cascade, which
    // is what makes the quota pacing, the fallback and the audit apply.
    expect(code).not.toMatch(/resend|mailgun|mailjet|maileroo|mailtrap/i);
    // And the copy comes from the shared module — a local template here would be
    // a second set of words in a consent path, which is the one thing the
    // owner's decision ruled out.
    expect(code).toMatch(/from '\.\.\/functions\/src\/lib\/confirmationEmailContent\.js'/);
    expect(code).not.toMatch(/<!DOCTYPE html>/i);
  });

  it('writes nothing and sends nothing unless asked: dry-run is the default', () => {
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    expect(src).toMatch(/includes\('--apply'\)/);
    // Both the send and the write helpers are reached only after the apply guard
    // returns. A delivered email is as irreversible as a terminal status.
    // Sliced to main() because the send helper is DEFINED above it — the
    // question is where it is CALLED.
    const body = src.slice(src.indexOf('async function main()'));
    expect(body.indexOf('if (!apply)')).toBeLessThan(body.indexOf('sendConfirmationRequests(db,'));
    expect(body.indexOf('if (!apply)')).toBeLessThan(body.indexOf('commitInChunks(db, expiring'));
  });

  it('fails closed when the link cannot be signed', () => {
    // An unsigned confirm link is a link that cannot confirm, and the attempt it
    // would consume is not given back. The guard has to be a refusal to send,
    // not a fallback to an unsigned URL.
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    const guard = src.slice(src.indexOf('const secret = process.env.NEWSLETTER_SECRET'));
    expect(guard).toMatch(/if \(!secret\)/);
    expect(guard.indexOf('if (!secret)')).toBeLessThan(guard.indexOf('sendConfirmationRequests(db,'));
  });

  it('counts an attempt only against a message that actually left', () => {
    // The ledger writes run over what the cascade returned, never over the plan.
    // A provider failure must cost a day, not one of the three: the opposite
    // ordering would spend somebody's whole cycle on an outage.
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    const fn = src.slice(src.indexOf('async function sendConfirmationRequests'));
    expect(fn).toMatch(/commitInChunks\(db, counted,/);
    expect(fn).not.toMatch(/commitInChunks\(db, (due|items|requests),/);
  });

  it('an ambiguous delivery counts, so the cycle cannot produce a fourth email', () => {
    // The shape neither sender had ever been shown: #4911's third outcome, where
    // the provider may already have sent the message and then failed on the
    // response. Treating it as a non-send is the intuitive reading and the wrong
    // one — the ledger would say two while three messages sit in an inbox, and
    // the run after next would send a fourth to somebody who never consented to
    // the first. The asymmetry is deliberate and it is asserted here, because
    // nothing else in the file would notice it being "simplified" away.
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    const fn = src.slice(src.indexOf('async function sendConfirmationRequests'));
    expect(fn).toMatch(/const ambiguous = failed\.filter\(\(f\) => f\.ambiguousDelivery\)/);
    expect(fn).toMatch(/const counted = \[\.\.\.sent, \.\.\.ambiguous\]/);
    // …and the two cases stay distinguishable afterwards: no message id is
    // invented for a send nobody can confirm happened.
    expect(fn).toMatch(/messageId: s\.messageId \|\| null/);
  });
});

describe('the words of a reminder: the confirmation email, re-framed and nothing more', () => {
  const FIRST_SENT = Date.parse('2026-08-20T09:15:00.000Z');
  const reminderItem = (attempt: number, locale = 'it', overrides: Record<string, any> = {}) => ({
    id: 'r@example.com',
    data: pendingDoc({
      preferred_locale: locale,
      confirmation_attempts: attempt - 1,
      confirmation_first_sent_at: new Date(FIRST_SENT).toISOString(),
      ...overrides,
    }),
    decision: { action: 'send', attempt, attempts: attempt - 1, reason: 'reminder' },
  });

  it('the body below the banner is the confirmation email, byte for byte', () => {
    // The owner's decision, as an assertion rather than as a promise: «riusare il
    // testo dell'email di conferma esistente, cambiando solo la cornice». A
    // reminder is the plain email with a banner glued to the front — so removing
    // the banner has to give the plain email back, exactly.
    const plain = buildNewsletterConfirmationEmailHtml('https://frontaliereticino.ch/?action=confirm_newsletter');
    for (const frame of [CONFIRMATION_FRAMES.REMINDER, CONFIRMATION_FRAMES.LAST]) {
      const framed = buildNewsletterConfirmationEmailHtml(
        'https://frontaliereticino.ch/?action=confirm_newsletter',
        'it',
        { frame, firstSentAt: FIRST_SENT },
      );
      const banner = confirmationReminderBanner('it', { frame, firstSentAt: FIRST_SENT });
      expect(banner.length).toBeGreaterThan(80);
      // …and the subject line, which is the one other thing that changes.
      expect(framed.replace(banner, '').replace(confirmationEmailSubject('it', { frame }), confirmationEmailSubject('it', {})))
        .toBe(plain);
    }
  });

  it('adds no link of its own — the confirm link is the only one that changes', () => {
    const hrefs = (html: string) => (html.match(/href="([^"]*)"/g) || []).sort();
    const plain = buildNewsletterConfirmationEmailHtml('https://frontaliereticino.ch/?action=confirm_newsletter');
    const last = buildNewsletterConfirmationEmailHtml(
      'https://frontaliereticino.ch/?action=confirm_newsletter',
      'it',
      { frame: CONFIRMATION_FRAMES.LAST, firstSentAt: FIRST_SENT },
    );
    expect(hrefs(last)).toEqual(hrefs(plain));
  });

  it('the first reminder says when we wrote, in each of the four languages', () => {
    const expected: Record<string, string> = {
      it: 'Ti avevamo scritto il 20 agosto 2026',
      en: 'We wrote to you on 20 August 2026',
      de: 'Wir haben Ihnen am 20. August 2026',
      fr: 'Nous vous avons écrit le 20 août 2026',
    };
    for (const [locale, sentence] of Object.entries(expected)) {
      const req = buildFollowupRequest(reminderItem(2, locale), { secret: 'test-secret' });
      expect(req.meta.frame).toBe(CONFIRMATION_FRAMES.REMINDER);
      expect(req.payload.html, locale).toContain(sentence);
      // …and it does NOT claim to be the last one.
      expect(req.payload.html, locale).not.toContain(t(locale, 'confirmReminderLastNotice'));
      expect(req.payload.subject).toBe(t(locale, 'confirmReminderSubject'));
    }
  });

  it('the second reminder says it is the last, and that doing nothing is enough', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const req = buildFollowupRequest(reminderItem(3, locale), { secret: 'test-secret' });
      expect(req.meta.frame).toBe(CONFIRMATION_FRAMES.LAST);
      expect(req.payload.html, locale).toContain(t(locale, 'confirmReminderLead').split('{when}')[0]);
      expect(req.payload.html, locale).toContain(t(locale, 'confirmReminderLastNotice'));
      expect(req.payload.subject).toBe(t(locale, 'confirmReminderLastSubject'));
    }
  });

  it('carries no offer and no urgency — the vocabulary a consent request may not use', () => {
    // Not a style note. Anything persuasive in this mail is persuasion aimed at
    // somebody who has not consented to be persuaded, and the whole reason the
    // owner chose to reuse the existing body is that new words here are new
    // claims. The list is the marketing register, in four languages.
    const forbidden = /gratis|free\b|sconto|offerta|promo|discount|angebot|rabatt|kostenlos|offre|gratuit|réduction|subito|hurry|scade tra|expires in|last chance|ultima occasione|solo per te|jetzt sichern/i;
    for (const locale of ['it', 'en', 'de', 'fr']) {
      for (const attempt of [2, 3]) {
        const { payload } = buildFollowupRequest(reminderItem(attempt, locale), { secret: 'test-secret' });
        const banner = confirmationReminderBanner(locale, {
          frame: attempt === 3 ? CONFIRMATION_FRAMES.LAST : CONFIRMATION_FRAMES.REMINDER,
          firstSentAt: FIRST_SENT,
        });
        expect(banner, `${locale}/${attempt}`).not.toMatch(forbidden);
        expect(payload.subject, `${locale}/${attempt}`).not.toMatch(forbidden);
      }
    }
  });

  it('never states a date it does not have — the undated wording, not «il undefined»', () => {
    // A document can reach a reminder with no first-send anchor: a row written
    // before the counter existed, whose only stamp is the overwritten
    // `confirmation_sent_at`. Reading THAT as "the day we first wrote" would put
    // the date of the previous reminder in the sentence, which is a false
    // statement made to somebody who has not consented to hear from us at all.
    const noAnchor = reminderItem(3, 'it', { confirmation_first_sent_at: undefined, confirmation_sent_at: daysAgo(1) });
    const { payload } = buildFollowupRequest(noAnchor, { secret: 'test-secret' });
    expect(payload.html).toContain('qualche giorno fa');
    expect(payload.html).not.toMatch(/undefined|NaN|Invalid Date/);
    // The last-reminder notice still has to be there: losing the date must not
    // cost the recipient the one sentence that says nothing more is coming.
    expect(payload.html).toContain(t('it', 'confirmReminderLastNotice'));
  });

  it('a fourth request could not be composed as a fresh signup', () => {
    // Belt and braces behind the cap: if the counter were ever bypassed, the
    // frame must not reset to "thanks for subscribing".
    expect(confirmationFrameForAttempt(4)).toBe(CONFIRMATION_FRAMES.LAST);
    expect(confirmationFrameForAttempt(99)).toBe(CONFIRMATION_FRAMES.LAST);
  });

  it('the date is the reader\'s calendar date, not UTC\'s', () => {
    // 23:40 UTC on the 20th is the 21st in Ticino. The date in this sentence is
    // the one the recipient can check against their own inbox.
    const lateEvening = Date.parse('2026-08-20T23:40:00.000Z');
    expect(formatConfirmationDate(lateEvening, 'it')).toBe('21 agosto 2026');
    expect(formatConfirmationDate(null, 'it')).toBeNull();
    expect(formatConfirmationDate(undefined, 'de')).toBeNull();
  });
});

describe('confirmationReturnPath: the pathname a reminder link returns to (#5843)', () => {
  it('keeps the pathname and drops query and fragment', () => {
    expect(confirmationReturnPath({ source_page: '/it/lavoro?x=1#y' })).toBe('/it/lavoro');
  });

  it('is null when there is no source page at all — the link stays on the root', () => {
    expect(confirmationReturnPath({})).toBeNull();
    expect(confirmationReturnPath(undefined)).toBeNull();
  });

  it('refuses a protocol-relative value — that would redirect off-site', () => {
    expect(confirmationReturnPath({ source_page: '//evil.com' })).toBeNull();
  });

  it('refuses an absolute URL', () => {
    expect(confirmationReturnPath({ source_page: 'https://evil.com' })).toBeNull();
  });

  it('falls back to the historical camelCase sourcePage', () => {
    expect(confirmationReturnPath({ sourcePage: '/en/jobs' })).toBe('/en/jobs');
  });

  it('is wired into the confirm link the reminder actually sends', () => {
    const item = {
      id: 'r2@example.com',
      data: { preferred_locale: 'it', source_page: '/it/lavoro?ref=footer' },
      decision: { action: 'send', attempt: 1, attempts: 0 },
    };
    const { payload } = buildFollowupRequest(item, { secret: 'test-secret' });
    expect(payload.html).toContain('href="https://frontaliereticino.ch/it/lavoro?action=confirm_newsletter');
    expect(payload.html).not.toContain('ref=footer');
  });
});

describe('the ledger both senders write, and the shapes it has never seen', () => {
  it('is one definition, shared by the Cloud Function and the runner', () => {
    // The construct that produced every drift defect in this area was a copied
    // check. The counter is the whole evidence of "asked three times and
    // stopped", so it has one writer.
    const cf = read('functions/src/newsletterConfirmationEmail.js');
    const runner = read('scripts/newsletter-confirmation-followups.mjs');
    for (const src of [cf, runner]) {
      expect(src).toMatch(/buildConfirmationSentFields\(/);
      expect(src).toMatch(/buildConfirmationSentEvent\(/);
      // Neither may hand-roll the increment.
      expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/confirmation_attempts:\s*attemptsBefore/);
    }
  });

  it('counts the attempt and anchors the window on the first send only', () => {
    const first = buildConfirmationSentFields({
      attemptsBefore: 0, isCycleSend: true, messageId: 'm1', locale: 'it', stamp: 'STAMP',
    });
    expect(first).toMatchObject({ confirmation_attempts: 1, confirmation_first_sent_at: 'STAMP' });

    const second = buildConfirmationSentFields({
      attemptsBefore: 1, isCycleSend: true, messageId: 'm2', locale: 'de', stamp: 'STAMP',
    });
    expect(second.confirmation_attempts).toBe(2);
    // The anchor is written once and never moved: it is the date the reminders
    // state, and a moving anchor would also stretch the window indefinitely.
    expect(second).not.toHaveProperty('confirmation_first_sent_at');
  });

  it('a login link and a re-probe leave the counter alone', () => {
    const notACycle = buildConfirmationSentFields({
      attemptsBefore: 2, isCycleSend: false, messageId: 'm', locale: 'it', stamp: 'STAMP',
    });
    expect(notACycle).not.toHaveProperty('confirmation_attempts');
    expect(notACycle).not.toHaveProperty('confirmation_first_sent_at');
    expect(buildConfirmationSentEvent({
      email: 'x@example.com', attemptsBefore: 2, isCycleSend: false, messageId: 'm', locale: 'it', occurredAt: 'ISO',
    }).confirmation_attempt).toBeNull();
  });

  it('reads the first-send anchor in both spellings, and refuses to guess', () => {
    // 458 documents in this collection carry only the camelCase stamp (#5673),
    // and the reminder's date comes from this reader.
    const iso = '2026-08-20T09:15:00.000Z';
    expect(confirmationFirstSentAt({ confirmation_first_sent_at: iso })).toBe(Date.parse(iso));
    expect(confirmationFirstSentAt({ confirmationFirstSentAt: iso })).toBe(Date.parse(iso));
    expect(confirmationFirstSentAt({ confirmation_first_sent_at: fsTimestamp(iso) })).toBe(Date.parse(iso));
    // NOT the last send, and not the creation date: either would put a wrong
    // date in a sentence addressed to somebody who has not consented.
    expect(confirmationFirstSentAt({ confirmation_sent_at: iso })).toBeNull();
    expect(confirmationFirstSentAt({ created_at: iso })).toBeNull();
  });
});

describe('the write that starts a cycle, and the one that stops asking', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
    vi.stubGlobal('window', { location: { pathname: '/', href: 'https://frontaliereticino.ch/' } });
    fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const merged = () => (setDocMock.mock.calls[0] as any[])[1] as Record<string, any>;

  it('a new signup starts a cycle: counter at zero, anchor stamped', () => {
    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });
    return captureNewsletterSubscriber({} as any, {
      email: 'new@example.com',
      source: 'popup',
      consentText: 'formula di prova',
    }).then(() => {
      expect(merged().status).toBe('pending');
      expect(merged().confirmation_attempts).toBe(0);
      expect(merged().confirmation_cycle_started_at).toBe('__server_timestamp__');
    });
  });

  it('a signup on an EXPIRED document restarts the cycle instead of inheriting its cap', async () => {
    // Without this the terminal state is a one-way door for a person who comes
    // back and asks to subscribe again — the counter still says three.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'again@example.com',
        status: 'expired',
        isActive: false,
        consent_text: 'formula di prova',
        confirmation_attempts: 3,
        confirmation_expired_at: daysAgo(8),
      }),
    });

    const result = await captureNewsletterSubscriber({} as any, { email: 'again@example.com', source: 'popup' });

    expect(result.status).toBe('pending');
    expect(merged().confirmation_attempts).toBe(0);
    expect(merged().confirmation_cycle_started_at).toBe('__server_timestamp__');
  });

  it('a repeat submit while already pending does NOT reset the counter', async () => {
    // Otherwise the cap is worth nothing: resubmitting the form would buy three
    // more requests every time.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ email: 'p@example.com', status: 'pending', consent_text: 'formula di prova', confirmation_attempts: 2 }),
    });

    await captureNewsletterSubscriber({} as any, { email: 'p@example.com', source: 'popup' });

    expect(merged()).not.toHaveProperty('confirmation_attempts');
    expect(merged()).not.toHaveProperty('confirmation_cycle_started_at');
  });

  it('asks a document that resolved to `pending` over an ACTIVE record — the send the old gate skipped', async () => {
    // `existed` is `alreadyActive`, and the gate used to be
    // `pending && !existed`. TaxCalendar's non-trusted branch passes
    // `status: 'pending'` explicitly, and an explicit status beats the existing
    // one — so this write produced a `pending` record that was never asked to
    // confirm and had no way out of that state.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ email: 'active@example.com', status: 'confirmed', isActive: true, active: true, consent_text: 'formula di prova' }),
    });

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'active@example.com',
      status: 'pending',
      isActive: false,
      source: 'tax_calendar',
    });

    expect(result.status).toBe('pending');
    expect(result.existed).toBe(true);
    // `requestConfirmationEmail` is fired non-awaited and dynamically imports
    // services/i18n first, so the fetch lands after this function resolves —
    // poll for it, with room for that first module load.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect((fetchMock.mock.calls[0] as any[])[0]).toBe(`${FUNCTIONS_BASE}/newsletterSendConfirmation`);
  });

  it('does NOT ask somebody who already confirmed, even when the write lands on `pending`', async () => {
    // The 848 again, this time at the write that would have mailed them.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'reprobe@example.com',
        status: 'pending',
        isActive: false,
        consent_text: 'formula di prova',
        confirmed_at: daysAgo(200),
      }),
    });

    const result = await upsertNewsletterSubscriber({} as any, { email: 'reprobe@example.com', status: 'pending', source: 'popup' });

    expect(result.status).toBe('pending');
    expect(result.hadConfirmationProof).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the proof exactly as the shared gate reads it, in every spelling', async () => {
    // `captureNewsletterSubscriber` reads the two fields inline rather than
    // importing a Cloud Functions module into the client bundle. That
    // duplication is allowed to exist only because this assertion exists.
    const shapes = [
      {},
      { confirmed_at: daysAgo(1) },
      { confirmedAt: daysAgo(1) },
      { status: 'confirmed' },
      { status: 'pending', confirmed_at: daysAgo(300) },
    ];
    for (const extra of shapes) {
      const data = { email: 'x@example.com', status: 'pending', consent_text: 'formula di prova', ...extra };
      getDocMock.mockResolvedValue({ exists: () => true, data: () => data });
      const result = await captureNewsletterSubscriber({} as any, { email: 'x@example.com', source: 'popup' });
      expect(result.hadConfirmationProof, JSON.stringify(extra)).toBe(hasConfirmationProof(data));
      setDocMock.mockClear();
    }
  });
});

/**
 * ── THE REPAIR SIDE OF THE SAME 848 ────────────────────────────────────────
 *
 * The blocks above prove the follow-up cycle never TOUCHES them. These prove
 * the opposite motion is equally bounded: `scripts/newsletter-confirmed-status-
 * backfill.mjs` corrects the `status` word on those documents — 843 of them
 * when re-measured on 2026-08-14 — and must never widen past it.
 *
 * Two failures are possible here and they are not symmetric. Writing `confirmed`
 * on a document with NO proof fabricates a consent on somebody who never gave
 * one, which is the failure the whole area exists to prevent; writing a SECOND
 * field moves a clock or a flag that other senders read. Each has its own
 * block below, and each was checked by mutation: removing the proof gate from
 * `planConfirmedStatusBackfill` and widening `buildConfirmedStatusFields` both
 * turn these red.
 */

/** A repair candidate: `pending`, with the stamp a confirmation click leaves. */
const reProbeDoc = (id: string, overrides: Record<string, any> = {}) => ({
  id,
  ref: strictRef(id),
  data: {
    email: id,
    status: 'pending',
    isActive: true,
    confirmed_at: daysAgo(200),
    suppressed_at: daysAgo(30),
    reactivated_at: daysAgo(29),
    ...overrides,
  },
});

/**
 * A ref that refuses everything except being written to.
 *
 * `.collection()` throwing is the assertion: it is the only way this script
 * could reach the event log, and an event written by a repair would be
 * fabricated evidence of a click that did not happen today.
 */
function strictRef(id: string) {
  return {
    id,
    collection: () => {
      throw new Error(`refused: ${id} must not have a subcollection touched by a status repair`);
    },
  };
}

/** A Firestore double that records every operation instead of performing one. */
function recordingDb() {
  const ops: Array<{ ref: any; data: any; opts: any; kind: string }> = [];
  let commits = 0;
  return {
    ops,
    commits: () => commits,
    db: {
      batch: () => ({
        set: (ref: any, data: any, opts: any) => ops.push({ ref, data, opts, kind: 'set' }),
        update: (ref: any, data: any) => ops.push({ ref, data, opts: null, kind: 'update' }),
        delete: (ref: any) => ops.push({ ref, data: null, opts: null, kind: 'delete' }),
        commit: async () => {
          commits += 1;
        },
      }),
    },
  };
}

describe('repairing the 843: proof selects, and nothing else does', () => {
  it('never selects a `pending` document with no proof at all — the fabricated-consent case', () => {
    // MUTATION CHECKED: delete the `if (!proof)` gate in
    // planConfirmedStatusBackfill and every one of these lands in `repair`.
    const noProof = [
      // Asked and never answered — the cohort the follow-up cycle is FOR.
      { id: 'asked@example.com', ref: strictRef('asked@example.com'), data: { status: 'pending', confirmation_sent_at: daysAgo(3), confirmation_attempts: 2 } },
      // `never_asked_backlog`: 0 today, and excluded whatever it becomes.
      // The confirmation was never even requested, so there is nothing to
      // reconstruct — including them would be a decision nobody has taken.
      { id: 'never@example.com', ref: strictRef('never@example.com'), data: { status: 'pending', created_at: daysAgo(400) } },
      // An event log that exists and says something else. Presence is not proof.
      { id: 'bounced@example.com', ref: strictRef('bounced@example.com'), data: { status: 'pending' }, events: [{ event_type: 'delivered' }, { event_type: 'bounce' }] },
      // An empty log is not proof either.
      { id: 'empty@example.com', ref: strictRef('empty@example.com'), data: { status: 'pending' }, events: [] },
    ];

    const plan = planConfirmedStatusBackfill(noProof);

    expect(plan.repair).toEqual([]);
    expect(plan.skipped['no-confirmation-proof']).toBe(noProof.length);
  });

  it('and the apply path writes nothing for them, end to end', async () => {
    // The same guarantee one layer down: the planner is what the runner feeds
    // to the writer, so a set of no-proof documents must produce zero writes
    // and zero commits — not "writes that happen to be harmless".
    const { db, ops, commits } = recordingDb();
    const plan = planConfirmedStatusBackfill([
      { id: 'a@example.com', ref: strictRef('a@example.com'), data: { status: 'pending' } },
      { id: 'b@example.com', ref: strictRef('b@example.com'), data: { status: 'pending', confirmation_sent_at: daysAgo(1) } },
    ]);

    const written = await applyConfirmedStatusBackfill(db, plan.repair);

    expect(written).toBe(0);
    expect(ops).toEqual([]);
    expect(commits()).toBe(0);
  });

  it('accepts the flat stamp in either spelling, and the `confirm` event on its own', () => {
    // The owner's rule: reconstruct the true state from the EVENTS, not from
    // the status. The flat stamp is the second reading of the same click and
    // the two coincided exactly at the time of writing — but the event is the
    // append-only one, so it must be sufficient by itself, without a stamp.
    expect(confirmationProofSource({ data: { confirmed_at: daysAgo(3) } })).toBe('flat');
    expect(confirmationProofSource({ data: { confirmedAt: daysAgo(3) } })).toBe('flat');
    expect(confirmationProofSource({ data: {}, events: [{ event_type: 'confirm' }] })).toBe('event');
    expect(confirmationProofSource({ data: { confirmed_at: daysAgo(3) }, events: [{ event_type: 'confirm' }] })).toBe('both');
    expect(confirmationProofSource({ data: { status: 'pending' } })).toBeNull();

    // The event is matched on its type and nothing else — `confirmation_email_sent`
    // is the record of US writing to them, the exact opposite of consent.
    expect(hasConfirmEvent([{ event_type: 'confirmation_email_sent' }])).toBe(false);
    expect(hasConfirmEvent([{ event_type: 'CONFIRM' }])).toBe(true);
    expect(hasConfirmEvent(undefined)).toBe(false);
  });

  it('selects an event-only document and counts it as the divergence signal', () => {
    // Zero of these existed when this was written. The count is reported by the
    // run precisely so a non-zero is noticed rather than assumed away.
    const plan = planConfirmedStatusBackfill([
      { id: 'evt@example.com', ref: strictRef('evt@example.com'), data: { status: 'pending' }, events: [{ event_type: 'confirm' }] },
      reProbeDoc('flat@example.com'),
    ]);

    expect(plan.repair.map((r: any) => r.id)).toEqual(['evt@example.com', 'flat@example.com']);
    expect(plan.eventOnly).toBe(1);
    expect(plan.proofSources).toMatchObject({ event: 1, flat: 1 });
  });

  it('leaves every status that is not `pending` alone, in both directions', () => {
    // Including the 392 that say `confirmed` with nothing behind them: this
    // script has no branch that writes `pending`, and repairing THAT is a
    // different decision with a different risk.
    const plan = planConfirmedStatusBackfill([
      { id: 'fabricated@example.com', ref: strictRef('fabricated@example.com'), data: { status: 'confirmed', restore_marker: 'mailtrap_suspension_mismapped' } },
      { id: 'gone@example.com', ref: strictRef('gone@example.com'), data: { status: 'unsubscribed', confirmed_at: daysAgo(9) } },
      { id: 'closed@example.com', ref: strictRef('closed@example.com'), data: { status: CONFIRMATION_EXPIRED_STATUS, confirmed_at: daysAgo(9) } },
    ]);

    expect(plan.repair).toEqual([]);
    expect(plan.skipped['not-pending']).toBe(3);
  });

  it('refuses to make a recorded opt-out mailable, the case the follow-up policy cannot see', () => {
    // `decideConfirmationFollowup` asks for proof BEFORE it asks about
    // opt-outs, so a document that confirmed once and later unsubscribed never
    // reaches its opt-out branch and is invisible in that runner's counts.
    // Writing `confirmed` over its `pending` hands the senders a mailable
    // status for somebody who asked to be left alone.
    const optedOut = reProbeDoc('left@example.com', {
      unsubscribed_at: daysAgo(10),
      confirmed_at: daysAgo(200),
    });

    const plan = planConfirmedStatusBackfill([optedOut]);

    expect(plan.repair).toEqual([]);
    expect(plan.skipped['opt-out-bound']).toBe(1);
    // Still counted as proven — the divergence measurement covers every proven
    // document, including the ones deliberately left where they are.
    expect(plan.proofSources.flat).toBe(1);
  });

  it('is idempotent because the repaired state is not selectable', () => {
    // Not a promise: `confirmed` is not `pending`, so the selection predicate
    // is its own completion check. A second run finds nothing to do.
    const doc = reProbeDoc('twice@example.com');
    expect(planConfirmedStatusBackfill([doc]).repair).toHaveLength(1);

    const afterRepair = { ...doc, data: { ...doc.data, ...buildConfirmedStatusFields() } };
    expect(planConfirmedStatusBackfill([afterRepair]).repair).toEqual([]);
    expect(planConfirmedStatusBackfill([afterRepair]).skipped['not-pending']).toBe(1);
  });
});

describe('repairing the 843: `status` is the only field that may be written', () => {
  it('the write payload carries exactly one key', () => {
    // MUTATION CHECKED: add any second key to buildConfirmedStatusFields — the
    // tempting ones are `isActive`, `updated_at`, `confirmed_at` — and this
    // fails. `updated_at` is not cosmetic: other readers time re-engagement off
    // it, and `confirmed_at` is the evidence the selection depends on, so a
    // repair that wrote it would be proving its own premise.
    expect(Object.keys(buildConfirmedStatusFields())).toEqual(['status']);
    expect(buildConfirmedStatusFields()).toEqual({ status: CONFIRMED_STATUS });
    expect(CONFIRMED_STATUS).toBe('confirmed');
  });

  it('and the real write path carries exactly that, merged, with no subcollection touched', async () => {
    // Asserted against the path the runner calls, not against the builder
    // alone: a builder can be correct and unused. The refs throw on
    // `.collection()`, so an event write would surface as a thrown error here
    // rather than as fabricated evidence in production.
    const { db, ops, commits } = recordingDb();
    const plan = planConfirmedStatusBackfill([
      reProbeDoc('one@example.com'),
      reProbeDoc('two@example.com', { confirmedAt: daysAgo(150), confirmed_at: undefined }),
    ]);

    const written = await applyConfirmedStatusBackfill(db, plan.repair);

    expect(written).toBe(2);
    expect(commits()).toBe(1);
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.kind).toBe('set');
      expect(Object.keys(op.data)).toEqual(['status']);
      expect(op.data.status).toBe(CONFIRMED_STATUS);
      // Merge, never a replace: a `.set()` without it would delete
      // `confirmed_at` — the proof — along with everything else on the document.
      expect(op.opts).toEqual({ merge: true });
    }
    expect(ops.map((o) => o.ref.id)).toEqual(['one@example.com', 'two@example.com']);
  });

  it('never emits an update or a delete', async () => {
    // The only two other operations a batch offers. Neither has a use here, and
    // a delete on this collection is the one thing #5764 settled: the record IS
    // the evidence and is KEPT.
    const { db, ops } = recordingDb();
    await applyConfirmedStatusBackfill(db, planConfirmedStatusBackfill([reProbeDoc('k@example.com')]).repair);
    expect(ops.filter((o) => o.kind !== 'set')).toEqual([]);
  });
});

describe('repairing the 843: it stops when the cohort is not the cohort', () => {
  it('accepts the measured population and the band around it', () => {
    expect(assessCohortDrift({ found: EXPECTED_REPAIR_COHORT })).toMatchObject({ ok: true, drift: 0 });
    expect(assessCohortDrift({ found: EXPECTED_REPAIR_COHORT - 40 }).ok).toBe(true);
    expect(assessCohortDrift({ found: EXPECTED_REPAIR_COHORT + 40 }).ok).toBe(true);
  });

  it('refuses a population that is far smaller — the truncated-read shape', () => {
    // A short read is the failure mode that looks like success: fewer documents
    // to repair reads as "less work", and `manifest.json`'s `counts` exists in
    // the sibling repo for exactly this reason.
    const verdict = assessCohortDrift({ found: 12 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('cohort-smaller-than-expected');
    expect(verdict.min).toBeGreaterThan(12);
  });

  it('refuses a population that is far larger — something is writing `pending` again', () => {
    // The cohort can only shrink on its own: its writer is retired and a member
    // leaves it by confirming, unsubscribing or expiring. Growth means a writer
    // nobody knows about, and repairing over it would hide that.
    const verdict = assessCohortDrift({ found: 4000 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('cohort-larger-than-expected');
  });

  it('keeps a usable band when an operator narrows `--expected`', () => {
    // The floor exists so a later run against a partially-repaired population
    // does not get a band of ±1.
    const verdict = assessCohortDrift({ found: 30, expected: 60 });
    expect(verdict.ok).toBe(true);
    expect(verdict.min).toBe(10);
    expect(verdict.max).toBe(110);
  });
});
