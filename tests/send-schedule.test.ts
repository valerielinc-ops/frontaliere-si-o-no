import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  computeScheduledSendAt,
  resolveEffectivePreferredHour,
  computeGlobalPreferredHour,
  perUserSendTimeEnabled,
  MIN_GLOBAL_SAMPLE_USERS,
} from '../scripts/lib/send-schedule.mjs';

// Fixed reference "now" — every offset below is relative to this constant,
// never to the real wall clock (see AGENTS.md "Test fixture: mai date assolute").
const NOW = new Date('2026-07-11T12:00:00.000Z');

describe('computeScheduledSendAt', () => {
  it('returns null for a non-integer/out-of-range preferredHourUtc', () => {
    expect(computeScheduledSendAt({ preferredHourUtc: null, email: 'a@b.ch', now: NOW })).toBeNull();
    expect(computeScheduledSendAt({ preferredHourUtc: undefined, email: 'a@b.ch', now: NOW })).toBeNull();
    expect(computeScheduledSendAt({ preferredHourUtc: 24, email: 'a@b.ch', now: NOW })).toBeNull();
    expect(computeScheduledSendAt({ preferredHourUtc: -1, email: 'a@b.ch', now: NOW })).toBeNull();
    expect(computeScheduledSendAt({ preferredHourUtc: 9.5, email: 'a@b.ch', now: NOW })).toBeNull();
  });

  it('schedules for later today when the preferred hour has not yet passed', () => {
    // NOW is 12:00 UTC — 18:00 today is still ahead by more than minLeadMs.
    const iso = computeScheduledSendAt({ preferredHourUtc: 18, email: 'a@b.ch', now: NOW });
    expect(iso).not.toBeNull();
    const d = new Date(iso as string);
    expect(d.getUTCFullYear()).toBe(NOW.getUTCFullYear());
    expect(d.getUTCMonth()).toBe(NOW.getUTCMonth());
    expect(d.getUTCDate()).toBe(NOW.getUTCDate());
    expect(d.getUTCHours()).toBe(18);
  });

  it('rolls over to tomorrow when the preferred hour has already passed today', () => {
    // NOW is 12:00 UTC — 09:00 today is in the past.
    const iso = computeScheduledSendAt({ preferredHourUtc: 9, email: 'a@b.ch', now: NOW });
    expect(iso).not.toBeNull();
    const d = new Date(iso as string);
    const expectedDay = new Date(NOW);
    expectedDay.setUTCDate(expectedDay.getUTCDate() + 1);
    expect(d.getUTCDate()).toBe(expectedDay.getUTCDate());
    expect(d.getUTCHours()).toBe(9);
  });

  it('rolls over to tomorrow when the candidate falls inside the minLeadMs anti-race window', () => {
    // now is exactly 12:00:00 UTC and the preferred hour equals now's hour
    // (12), so today's candidate always lands somewhere in [12:00, 12:59]
    // regardless of the email's minute jitter. A minLeadMs of just over an
    // hour (61min) always exceeds that whole range, forcing the rollover
    // path deterministically — no need to know the exact jittered minute.
    const now = new Date('2026-07-11T12:00:00.000Z');
    const iso = computeScheduledSendAt({
      preferredHourUtc: 12,
      email: 'anyone@example.com',
      now,
      minLeadMs: 61 * 60 * 1000,
    });
    const d = new Date(iso as string);
    expect(d.getUTCDate()).toBe(now.getUTCDate() + 1);
    expect(d.getUTCHours()).toBe(12);
  });

  it('picks a deterministic minute jitter: same email always yields the same minute', () => {
    const iso1 = computeScheduledSendAt({ preferredHourUtc: 20, email: 'stable@example.com', now: NOW });
    const iso2 = computeScheduledSendAt({ preferredHourUtc: 20, email: 'stable@example.com', now: NOW });
    expect(iso1).toBe(iso2);
  });

  it('spreads different emails across generally different minutes (jitter is not constant)', () => {
    const minutes = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      const iso = computeScheduledSendAt({ preferredHourUtc: 20, email: `user${i}@example.com`, now: NOW });
      minutes.add(new Date(iso as string).getUTCMinutes());
    }
    // 30 distinct emails should not all collapse onto one minute value.
    expect(minutes.size).toBeGreaterThan(1);
  });

  it('always returns an ISO string with :00 seconds/milliseconds', () => {
    const iso = computeScheduledSendAt({ preferredHourUtc: 7, email: 'anyone@example.com', now: NOW }) as string;
    expect(iso).toMatch(/:\d{2}:00\.000Z$/);
  });
});

describe('resolveEffectivePreferredHour', () => {
  it('prefers the personal hour when sample count meets the threshold', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: 5 },
      fallbackDoc: { preferred_send_hour_utc: 8, preferred_send_sample_count: 10 },
      globalHour: 20,
    });
    expect(result).toEqual({ hourUtc: 14, source: 'personal' });
  });

  it('falls back to fallbackDoc when the primary lacks enough samples', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: 1 },
      fallbackDoc: { preferred_send_hour_utc: 8, preferred_send_sample_count: 5 },
      globalHour: 20,
    });
    expect(result).toEqual({ hourUtc: 8, source: 'fallback-doc' });
  });

  it('falls back to the global hour when neither doc has enough samples', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: 1 },
      fallbackDoc: { preferred_send_hour_utc: 8, preferred_send_sample_count: 2 },
      globalHour: 20,
    });
    expect(result).toEqual({ hourUtc: 20, source: 'global' });
  });

  it('returns null/null when there is no personal, fallback, or global signal', () => {
    const result = resolveEffectivePreferredHour({ subscriberDoc: null, fallbackDoc: null, globalHour: null });
    expect(result).toEqual({ hourUtc: null, source: null });
  });

  it('treats hour 0 as a valid preference, not a falsy "no data" sentinel', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 0, preferred_send_sample_count: 5 },
      globalHour: 20,
    });
    expect(result).toEqual({ hourUtc: 0, source: 'personal' });
  });

  it('accepts the camelCase projection shape (subscriberFromFirestoreRow output)', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferredSendHourUtc: 6, preferredSendSampleCount: 4 },
      globalHour: null,
    });
    expect(result).toEqual({ hourUtc: 6, source: 'personal' });
  });

  it('ignores a fallbackDoc that itself has no valid hour', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: null, preferred_send_sample_count: 0 },
      fallbackDoc: { preferred_send_hour_utc: null, preferred_send_sample_count: 0 },
      globalHour: 5,
    });
    expect(result).toEqual({ hourUtc: 5, source: 'global' });
  });

  it('respects a custom minEvents threshold', () => {
    const result = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: 2 },
      globalHour: null,
      minEvents: 2,
    });
    expect(result).toEqual({ hourUtc: 14, source: 'personal' });
  });
});

describe('computeGlobalPreferredHour', () => {
  function qualified(hourUtc: number) {
    return { preferred_send_hour_utc: hourUtc, preferred_send_sample_count: 3 };
  }

  it('returns null below MIN_GLOBAL_SAMPLE_USERS qualified users', () => {
    expect(MIN_GLOBAL_SAMPLE_USERS).toBe(5);
    const users = [qualified(10), qualified(11), qualified(12), qualified(13)]; // only 4
    const result = computeGlobalPreferredHour(users);
    expect(result.hourUtc).toBeNull();
    expect(result.sampleUsers).toBe(4);
  });

  it('computes an unweighted circular mean once MIN_GLOBAL_SAMPLE_USERS is met', () => {
    const users = [qualified(9), qualified(9), qualified(9), qualified(9), qualified(9)];
    const result = computeGlobalPreferredHour(users);
    expect(result.sampleUsers).toBe(5);
    expect(result.hourUtc).toBe(9);
  });

  it('wraps around midnight (23 and 1 average to 0, not 12)', () => {
    const users = [qualified(23), qualified(23), qualified(1), qualified(1), qualified(0)];
    const result = computeGlobalPreferredHour(users);
    expect(result.sampleUsers).toBe(5);
    expect(result.hourUtc).toBe(0);
  });

  it('ignores users below the per-user minEvents threshold', () => {
    const users = [
      qualified(9), qualified(9), qualified(9), qualified(9), qualified(9),
      { preferred_send_hour_utc: 3, preferred_send_sample_count: 1 }, // cold start — excluded
      { preferred_send_hour_utc: 15, preferred_send_sample_count: 0 }, // no samples — excluded
    ];
    const result = computeGlobalPreferredHour(users);
    expect(result.sampleUsers).toBe(5);
    expect(result.hourUtc).toBe(9);
  });

  it('ignores users with no valid hour', () => {
    const users = [
      qualified(9), qualified(9), qualified(9), qualified(9), qualified(9),
      { preferred_send_hour_utc: null, preferred_send_sample_count: 10 },
    ];
    const result = computeGlobalPreferredHour(users);
    expect(result.sampleUsers).toBe(5);
  });

  it('handles an empty/non-array input gracefully', () => {
    expect(computeGlobalPreferredHour([])).toEqual({ hourUtc: null, sampleUsers: 0 });
    expect(computeGlobalPreferredHour(undefined as never)).toEqual({ hourUtc: null, sampleUsers: 0 });
  });
});

describe('perUserSendTimeEnabled', () => {
  const ORIGINAL = process.env.PER_USER_SEND_TIME;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PER_USER_SEND_TIME;
    else process.env.PER_USER_SEND_TIME = ORIGINAL;
  });

  it('defaults to enabled when the env var is unset', () => {
    delete process.env.PER_USER_SEND_TIME;
    expect(perUserSendTimeEnabled()).toBe(true);
  });

  it('is disabled by "off"', () => {
    process.env.PER_USER_SEND_TIME = 'off';
    expect(perUserSendTimeEnabled()).toBe(false);
  });

  it('is disabled by "0"', () => {
    process.env.PER_USER_SEND_TIME = '0';
    expect(perUserSendTimeEnabled()).toBe(false);
  });

  it('is disabled by "false" (case-insensitive)', () => {
    process.env.PER_USER_SEND_TIME = 'FALSE';
    expect(perUserSendTimeEnabled()).toBe(false);
  });

  it('stays enabled for any other value (e.g. "on", "1")', () => {
    process.env.PER_USER_SEND_TIME = 'on';
    expect(perUserSendTimeEnabled()).toBe(true);
    process.env.PER_USER_SEND_TIME = '1';
    expect(perUserSendTimeEnabled()).toBe(true);
  });
});
