import { describe, it, expect } from 'vitest';
import {
  isRetryable,
  SUPPRESSION_RETRY_GRACE_DAYS,
} from '../scripts/lib/mailtrapSuppressionRetry.mjs';
import { classify } from '../scripts/lib/mailtrapSuspensionClassify.mjs';

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
