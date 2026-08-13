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
  isConfirmationCycleSend,
  buildConfirmationExpiryFields,
  MAX_CONFIRMATION_ATTEMPTS,
  MIN_ATTEMPT_INTERVAL_MS,
  CONFIRMATION_WINDOW_MS,
  CONFIRMATION_EXPIRED_STATUS,
  DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH,
} from '../functions/src/lib/confirmationFollowup.js';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES, isNewsletterExcluded } from '../services/emailSuppression.mjs';
import {
  isTerminalSuppression,
  positiveEventRecoveryFields,
  HUMAN_DECLARED_SUPPRESSIONS,
  MACHINE_INFERRED_SUPPRESSIONS,
} from '../functions/src/lib/subscriberReactivation.js';
import { planConfirmationFollowups, maskEmail } from '../scripts/newsletter-confirmation-followups.mjs';
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
    expect(src).toMatch(/confirmation_attempts\s*=\s*attemptsBefore \+ 1/);
    expect(src.indexOf('confirmationSendRefusal({')).toBeLessThan(src.indexOf('sendEmailCascade(['));
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

  it('puts no mail on the wire, so no reminder can ship without a channel verdict', () => {
    // A tripwire, not a preference. tests/helpers/senders.ts derives the sender
    // population from `sendEmailCascade` on disk; the day this file imports it,
    // tests/no-channel-mails-unconfirmed.test.ts and
    // tests/no-channel-mails-opted-out.test.ts both fail until it carries an
    // explicit verdict in each — which is exactly the review the reminder text
    // needs before it reaches anybody.
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/sendEmailCascade/);
    // And it must not have found a side door either: no provider client, no
    // fetch to a send endpoint.
    expect(code).not.toMatch(/resend|mailgun|mailjet|maileroo|mailtrap/i);
  });

  it('writes nothing unless asked: dry-run is the default', () => {
    const src = read('scripts/newsletter-confirmation-followups.mjs');
    expect(src).toMatch(/includes\('--apply'\)/);
    // The write helpers are reached only after the apply guard returns.
    expect(src.indexOf("if (!apply)")).toBeLessThan(src.indexOf('commitInChunks(db, expiring'));
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
