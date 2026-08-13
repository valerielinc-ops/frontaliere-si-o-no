import { describe, it, expect } from 'vitest';
import {
  isRetryable,
  SUPPRESSION_RETRY_GRACE_DAYS,
} from '../scripts/lib/mailtrapSuppressionRetry.mjs';
import { classify, decideRestore } from '../scripts/lib/mailtrapSuspensionClassify.mjs';
import { AUTO_CONFIRMED_ORIGIN_RE, HARD_BOUNCE_PATTERN } from '../scripts/lib/suppressionDecay.mjs';

/**
 * Guards the two decision points behind
 * scripts/mailtrap-suppression-retry.mjs and
 * scripts/restore-mailtrap-suspension-suppressions.mjs — the scripts that
 * decide which suppressed subscribers get a mail cascade again. Neither had
 * any test before this file (#5558): a regression here is invisible to every
 * gate and shows up only as subscribers who silently stop receiving mail.
 */

const NOW = 1_700_000_000_000; // fixed reference; all fixtures relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

describe('isRetryable (scripts/lib/mailtrapSuppressionRetry.mjs)', () => {
  it('is not retryable one day inside the grace period', () => {
    const sub = { suppressed_at: daysAgo(SUPPRESSION_RETRY_GRACE_DAYS - 1) };
    expect(isRetryable(sub, NOW)).toBe(false);
  });

  it('is retryable exactly at the grace-period boundary', () => {
    const sub = { suppressed_at: daysAgo(SUPPRESSION_RETRY_GRACE_DAYS) };
    expect(isRetryable(sub, NOW)).toBe(true);
  });

  it('is retryable well past the grace period', () => {
    const sub = { suppressed_at: daysAgo(SUPPRESSION_RETRY_GRACE_DAYS + 30) };
    expect(isRetryable(sub, NOW)).toBe(true);
  });

  it('treats a missing suppressed_at as immediately retryable, not blocked forever', () => {
    expect(isRetryable({}, NOW)).toBe(true);
    expect(isRetryable({ suppressed_at: null }, NOW)).toBe(true);
  });

  it('treats an unparseable suppressed_at the same as missing', () => {
    expect(isRetryable({ suppressed_at: 'not-a-date' }, NOW)).toBe(true);
  });

  it('accepts a Firestore Timestamp-shaped value via toDate()', () => {
    const sub = { suppressed_at: { toDate: () => new Date(daysAgo(SUPPRESSION_RETRY_GRACE_DAYS + 5)) } };
    expect(isRetryable(sub, NOW)).toBe(true);
  });

  it('accepts a plain ISO string', () => {
    const sub = { suppressed_at: new Date(daysAgo(SUPPRESSION_RETRY_GRACE_DAYS + 5)).toISOString() };
    expect(isRetryable(sub, NOW)).toBe(true);
  });
});

describe('classify (scripts/lib/mailtrapSuspensionClassify.mjs)', () => {
  it('flags suspension-only history as restorable evidence', () => {
    const v = classify([{ event_type: 'suppressed', mailtrap_event: 'suspension' }]);
    expect(v).toEqual({ sawSuspension: true, sawRealFailure: false, sawUnsubscribe: false });
  });

  it('flags a real bounce/complaint/reject as a real failure, never restorable', () => {
    for (const raw of ['bounce', 'complaint', 'reject', 'spam']) {
      const v = classify([{ event_type: 'suppressed', mailtrap_event: raw }]);
      expect(v.sawRealFailure).toBe(true);
      expect(v.sawSuspension).toBe(false);
    }
  });

  it('treats an empty/unrecognised raw suppressed event as a real failure, not a guess', () => {
    const v = classify([{ event_type: 'suppressed' }]);
    expect(v).toEqual({ sawSuspension: false, sawRealFailure: true, sawUnsubscribe: false });
  });

  it('a suspension event alongside a real failure is NOT restorable — real failure wins', () => {
    const v = classify([
      { event_type: 'suppressed', mailtrap_event: 'suspension' },
      { event_type: 'suppressed', mailtrap_event: 'bounce' },
    ]);
    expect(v.sawSuspension).toBe(true);
    expect(v.sawRealFailure).toBe(true);
  });

  it('flags an explicit unsubscribe event independently of the suppressed events', () => {
    const v = classify([{ event_type: 'unsubscribed' }]);
    expect(v).toEqual({ sawSuspension: false, sawRealFailure: false, sawUnsubscribe: true });
  });

  it('also recognises unsubscribe via a raw provider_event, not just event_type', () => {
    const v = classify([{ event_type: 'suppressed', provider_event: 'unsubscribe' }]);
    expect(v.sawUnsubscribe).toBe(true);
  });

  it('is conservative on zero event history: no suspension evidence at all', () => {
    const v = classify([]);
    expect(v).toEqual({ sawSuspension: false, sawRealFailure: false, sawUnsubscribe: false });
  });

  it(
    'documented divergence from isRetryable(): on a status=suppressed doc with ' +
      'zero recorded events, isRetryable() is permissive (missing age signal -> ' +
      'retryable) while classify() is conservative (missing suspension evidence -> ' +
      'stays suppressed) — see scripts/lib/mailtrapSuspensionClassify.mjs docstring ' +
      'for why this is intentional, not a bug: isRetryable() only flips status to ' +
      '"pending" and lets the normal send cascade self-heal, classify() decides a ' +
      'stronger confirmed/pending claim about root cause.',
    () => {
      const docWithNoEvents = { status: 'suppressed' }; // no suppressed_at, no events subcollection entries
      expect(isRetryable(docWithNoEvents, NOW)).toBe(true);
      expect(classify([]).sawSuspension).toBe(false); // caller leaves it suppressed on this signal
    },
  );
});

/**
 * ── decideRestore(): the widened selection, and the gate that makes it safe ──
 *
 * scripts/restore-mailtrap-suspension-suppressions.mjs used to select
 * `status == 'suppressed'` (2 docs in production, 2026-08-11). The population
 * it was written for is 281 `newsletter_subscribers` docs in `status:
 * 'bounced'`: `bounce_reason` exactly `reject`, NO `bounce_severity` field at
 * all, all bounced 2026-06-13..06-27 and none after 2026-07-01. Today's code
 * cannot produce that state — `mapMailtrapEvent` maps `reject → 'bounce'`,
 * `classifyBounceSeverity({provider:'mailtrap', rawEvent:'reject'})` returns
 * `'soft'`, and `bounceUpdateFields({severity:'soft'})` never writes `status`.
 *
 * Widening the status filter is therefore necessary — and on its own it is
 * DANGEROUS. Measured on the real data, the widened query returns 398 docs and
 * the precedence as it stood BEFORE the terminal gate would have restored 295
 * of them, 14 carrying a genuine `bounce_severity: 'hard'` — two Gmail
 * `NoSuchUser`, one `address unknown`, four escalated after 3 consecutive soft
 * rejects, three mailbox-full, two over-quota. The reason it cannot see them is the
 * blind spot pinned in the block below: `classify()` reads only
 * `event_type === 'suppressed'` events, and BOTH the recoverable `reject` AND
 * a real hard bounce are logged as `event_type: 'bounce'`.
 *
 * These tests pin BOTH versanti. The second half — the hard fixtures staying
 * suppressed — is the one that matters: without it this widening resurrects
 * mailboxes the provider declares nonexistent.
 */
describe('decideRestore (scripts/lib/mailtrapSuspensionClassify.mjs)', () => {
  /** The suspension event log every doc in the 281 cohort carries. */
  const suspensionEvents = [
    { event_type: 'suppressed', mailtrap_event: 'suspension' },
    { event_type: 'suppressed', mailtrap_event: 'suspension' },
  ];

  /** A doc from the recoverable 281: reject, no severity field, June bounce. */
  const cohort281 = (extra: Record<string, unknown> = {}) => ({
    status: 'bounced',
    bounce_reason: 'reject',
    bounced_at: daysAgo(52),
    open_count: 0,
    ...extra,
  });

  describe('the 281-address cohort is restored', () => {
    it('restores a reject-bounced doc with consent evidence as confirmed', () => {
      const v = decideRestore({
        sub: cohort281({ confirmed_at: daysAgo(400) }),
        events: [...suspensionEvents, { event_type: 'confirm' }],
        nowMs: NOW,
      });
      expect(v.restore).toBe(true);
      expect(v.code).toBe('suspension-mismapped');
      expect(v.confirmed).toBe(true);
    });

    it('a `bounced` status is in scope at all — the old `suppressed`-only filter missed the whole cohort', () => {
      expect(decideRestore({ sub: cohort281({ confirmed_at: daysAgo(400) }), events: suspensionEvents, nowMs: NOW }).restore).toBe(true);
      // and the original population is still handled
      expect(
        decideRestore({
          sub: { status: 'suppressed', suppressed_at: daysAgo(40), confirmed_at: daysAgo(400) },
          events: suspensionEvents,
          nowMs: NOW,
        }).restore,
      ).toBe(true);
    });

    it('is age-independent: only the terminal half of the decay verdict is read', () => {
      const sub = cohort281({ confirmed_at: daysAgo(400) });
      // One day old (inside NEVER_PROBED_COOLDOWN_DAYS) vs three years old.
      const fresh = decideRestore({ sub: { ...sub, bounced_at: NOW - DAY }, events: suspensionEvents, nowMs: NOW });
      const ancient = decideRestore({ sub: { ...sub, bounced_at: daysAgo(1000) }, events: suspensionEvents, nowMs: NOW });
      expect(fresh.restore).toBe(true);
      expect(ancient.restore).toBe(true);
      expect(fresh.code).toBe(ancient.code);
    });
  });

  describe('THE GATE — the 14 hard bounces are never restored', () => {
    /**
     * The exact shape that makes this test load-bearing: the doc carries the
     * SAME suspension event log as the recoverable cohort, so every
     * event-log signal says "restore". Only `bounce_severity` says otherwise.
     */
    const hardNoSuchUser = {
      status: 'bounced',
      bounce_severity: 'hard',
      bounce_reason:
        "550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos. NoSuchUser",
      bounced_at: daysAgo(52),
      confirmed_at: daysAgo(400),
      open_count: 3,
      last_delivered_at: daysAgo(300),
    };

    it('a Gmail NoSuchUser hard bounce is KEPT suppressed', () => {
      const v = decideRestore({ sub: hardNoSuchUser, events: suspensionEvents, nowMs: NOW });
      expect(v.restore).toBe(false);
      expect(v.code).toBe('hard-severity');
    });

    it(
      'REGRESSION PIN: the event log alone cannot tell that doc apart from the 281 — ' +
        'classify() sees no real failure on it, so the pre-gate precedence would have ' +
        'restored a mailbox the provider says does not exist',
      () => {
        const signals = classify(suspensionEvents);
        expect(signals.sawSuspension).toBe(true);
        expect(signals.sawRealFailure).toBe(false); // ← the blind spot
        expect(signals.sawUnsubscribe).toBe(false);
        // Same three signals, opposite correct outcome: the gate, not the log.
        expect(decideRestore({ sub: hardNoSuchUser, events: suspensionEvents, nowMs: NOW }).restore).toBe(false);
        expect(
          decideRestore({ sub: { status: 'bounced', bounce_reason: 'reject', confirmed_at: daysAgo(400) }, events: suspensionEvents, nowMs: NOW }).restore,
        ).toBe(true);
      },
    );

    it('an escalated soft-reject doc is kept — the FIELD catches what the regex cannot', () => {
      const reason = 'reject (escalated after 3 consecutive soft rejects)';
      // This is the whole reason the gate reads `bounce_severity` and not only
      // the reason text: `maybeEscalateSoftBounce()` writes a deliberately
      // permanent suppression whose prose matches no hard-bounce phrase.
      expect(HARD_BOUNCE_PATTERN.test(reason)).toBe(false);
      const v = decideRestore({
        sub: { status: 'bounced', bounce_severity: 'hard', bounce_reason: reason, bounced_at: daysAgo(52), confirmed_at: daysAgo(400), last_delivered_at: daysAgo(60) },
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(v.restore).toBe(false);
      expect(v.code).toBe('hard-severity');
    });

    it('mailbox-full and over-quota docs marked hard are kept', () => {
      for (const reason of ['552 5.2.2 mailbox full', 'user is over quota']) {
        const v = decideRestore({
          sub: { status: 'bounced', bounce_severity: 'hard', bounce_reason: reason, bounced_at: daysAgo(52), confirmed_at: daysAgo(400) },
          events: suspensionEvents,
          nowMs: NOW,
        });
        expect(v.restore).toBe(false);
        expect(v.code).toBe('hard-severity');
      }
    });

    it('a pre-classifier doc with no severity field but an unambiguous reason is kept on the legacy regex', () => {
      const v = decideRestore({
        sub: { status: 'bounced', bounce_reason: '550 5.1.1 <x>: Recipient address rejected: User unknown', bounced_at: daysAgo(52), confirmed_at: daysAgo(400) },
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(v.restore).toBe(false);
      expect(v.code).toBe('hard-reason');
    });

    it('human decisions outrank the suspension evidence, whatever the current status says', () => {
      const base = { status: 'bounced', bounce_reason: 'reject', bounced_at: daysAgo(52), confirmed_at: daysAgo(400) };
      expect(decideRestore({ sub: { ...base, complained_at: daysAgo(60) }, events: suspensionEvents, nowMs: NOW }))
        .toMatchObject({ restore: false, code: 'human-complaint-stamp' });
      expect(decideRestore({ sub: { ...base, confirmed_at: undefined, unsubscribed_at: daysAgo(60) }, events: suspensionEvents, nowMs: NOW }))
        .toMatchObject({ restore: false, code: 'human-unsubscribe-stamp' });
      expect(decideRestore({ sub: { status: 'unsubscribed' }, events: suspensionEvents, nowMs: NOW }))
        .toMatchObject({ restore: false, code: 'human-status' });
    });

    it('an exhausted re-probe budget is terminal too', () => {
      const v = decideRestore({
        sub: { status: 'bounced', bounce_reason: 'reject', bounced_at: daysAgo(52), reprobe_count: 2 },
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(v.restore).toBe(false);
      expect(v.code).toBe('probe-exhausted');
    });
  });

  describe('the pre-existing precedence still holds on the widened selection', () => {
    it('a real failure in the event log keeps the doc suppressed', () => {
      const v = decideRestore({
        sub: cohort281({ confirmed_at: daysAgo(400) }),
        events: [...suspensionEvents, { event_type: 'suppressed', mailtrap_event: 'bounce' }],
        nowMs: NOW,
      });
      expect(v).toMatchObject({ restore: false, code: 'real-failure' });
    });

    it('no suspension evidence at all keeps the doc suppressed', () => {
      expect(decideRestore({ sub: cohort281(), events: [], nowMs: NOW }))
        .toMatchObject({ restore: false, code: 'no-suspension-evidence' });
    });

    it('an unsubscribe EVENT stops it even without a stamp — decay never reads the event log', () => {
      const v = decideRestore({
        sub: cohort281({ confirmed_at: daysAgo(400) }),
        events: [...suspensionEvents, { event_type: 'unsubscribed' }],
        nowMs: NOW,
      });
      expect(v).toMatchObject({ restore: false, code: 'unsubscribed' });
    });

    it('a mailable or engagement-sunset doc is never "restored", however the caller widens its query', () => {
      for (const status of ['confirmed', 'pending', 'active', 'inactive']) {
        expect(decideRestore({ sub: { status, confirmed_at: daysAgo(400) }, events: suspensionEvents, nowMs: NOW }))
          .toMatchObject({ restore: false, code: 'not-suppressed' });
      }
    });
  });

  describe('consent is never fabricated', () => {
    it('no doc without real proof of consent comes back as confirmed', () => {
      // No confirmed_at, no confirm/subscribe_completed event, and an origin
      // that AUTO_CONFIRMED_ORIGIN_RE does not match: restored, but `pending`,
      // so the double opt-in is still owed. Verified against the real cohort
      // (2026-08-11): 278/281 carry BOTH a confirmed_at and an explicit
      // confirm event, and ZERO would have qualified on the origin heuristic
      // alone — the restore does not lean on it.
      const v = decideRestore({
        sub: cohort281({ source: 'newsletter_footer', source_cta: 'footer_form' }),
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(v.restore).toBe(true);
      expect(v.confirmed).toBe(false);
    });

    it('publisher_gate_email stays pending — pending-BY-DESIGN, and the prefix must not match it', () => {
      expect(AUTO_CONFIRMED_ORIGIN_RE.test('publisher_gate_email')).toBe(false);
      const v = decideRestore({ sub: cohort281({ source: 'publisher_gate_email' }), events: suspensionEvents, nowMs: NOW });
      expect(v.restore).toBe(true);
      expect(v.confirmed).toBe(false);
    });

    it('an explicit confirm event is enough on its own, with no confirmed_at stamp', () => {
      // `confirm`, and it has to be that word. This assertion used to feed a
      // `subscribe_completed` under this same title, and the title was the
      // false half: the SIGNUP writes `subscribe_completed`
      // (services/newsletterSubscribers.ts, and the `resubscribe` branch of
      // newsletterSubscriptionManagement.js), the confirmation click writes
      // `confirm`. Reading the request as the answer is the whole of #5686,
      // and here it reached a WRITE — `recoveredStatus()` minting the word
      // `confirmed` weekly under `--apply`. Fixed in #5717.
      const v = decideRestore({
        sub: cohort281(),
        events: [...suspensionEvents, { event_type: 'confirm' }],
        nowMs: NOW,
      });
      expect(v).toMatchObject({ restore: true, confirmed: true });
    });

    it('a subscribe_completed event is NOT — it records the request, not the answer', () => {
      // 495 of the 550 documents that reached a sender with no stamp carry one
      // (2026-08-13), against 0 carrying a `confirm`. Accepting it is what made
      // the two indistinguishable.
      const v = decideRestore({
        sub: cohort281(),
        events: [...suspensionEvents, { event_type: 'subscribe_completed' }],
        nowMs: NOW,
      });
      expect(v).toMatchObject({ restore: true, confirmed: false });
    });

    it('an auto-confirming signup origin is NOT either — it is an inference from the form', () => {
      // `signup` matches AUTO_CONFIRMED_ORIGIN_RE, and until #5717 that alone
      // resolved the restore to `confirmed`. The regex still decides the status
      // a NEW signup is BORN with (services/newsletterSubscribers.ts), which is
      // legitimate — a job unlock really is an act, performed live. Reading it
      // back off an old document months later and calling it a click is not.
      expect(AUTO_CONFIRMED_ORIGIN_RE.test('signup')).toBe(true);
      const v = decideRestore({
        sub: cohort281({ source: 'signup', source_cta: 'job_gate' }),
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(v).toMatchObject({ restore: true, confirmed: false });
    });

    it('a kept doc never reports confirmed:true — the flag cannot leak past a refusal', () => {
      const kept = decideRestore({
        sub: { status: 'bounced', bounce_severity: 'hard', bounce_reason: 'no such user', confirmed_at: daysAgo(400) },
        events: suspensionEvents,
        nowMs: NOW,
      });
      expect(kept.restore).toBe(false);
      expect(kept.confirmed).toBe(false);
    });
  });
});
