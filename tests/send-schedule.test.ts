import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  computeScheduledSendAt,
  resolveEffectivePreferredHour,
  computeGlobalPreferredHour,
  perUserSendTimeEnabled,
  logScheduleDistribution,
  MIN_GLOBAL_SAMPLE_USERS,
} from '../scripts/lib/send-schedule.mjs';
import { PREFERRED_SEND_MIN_EVENTS } from '../functions/src/lib/preferredSendHour.js';

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

  it('is deterministic and does not throw when email is empty, null, or undefined (String(email || "") fallback)', () => {
    const emptyIso = computeScheduledSendAt({ preferredHourUtc: 5, email: '', now: NOW });
    const nullIso = computeScheduledSendAt({ preferredHourUtc: 5, email: null as never, now: NOW });
    const undefinedIso = computeScheduledSendAt({ preferredHourUtc: 5, email: undefined as never, now: NOW });
    expect(emptyIso).not.toBeNull();
    // null/undefined collapse to the same '' input as an explicit empty string,
    // so all three must land on the exact same jittered minute.
    expect(nullIso).toBe(emptyIso);
    expect(undefinedIso).toBe(emptyIso);
  });

  it('is deterministic for an email containing unicode characters', () => {
    const email = 'ünïçødé.ключ.例え@münchen.example';
    const iso1 = computeScheduledSendAt({ preferredHourUtc: 5, email, now: NOW });
    const iso2 = computeScheduledSendAt({ preferredHourUtc: 5, email, now: NOW });
    expect(iso1).not.toBeNull();
    expect(iso1).toBe(iso2);
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

  // Regression guard for the #3798 code-review cleanup: resolveEffectivePreferredHour's
  // default minEvents must come from the imported PREFERRED_SEND_MIN_EVENTS constant
  // (functions/src/lib/preferredSendHour.js), not a hand-copied literal — this test
  // breaks the moment the two drift apart, without ever hardcoding the threshold value.
  it('defaults minEvents to the imported PREFERRED_SEND_MIN_EVENTS constant', () => {
    const atThreshold = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: PREFERRED_SEND_MIN_EVENTS },
      globalHour: null,
    });
    expect(atThreshold).toEqual({ hourUtc: 14, source: 'personal' });

    const belowThreshold = resolveEffectivePreferredHour({
      subscriberDoc: { preferred_send_hour_utc: 14, preferred_send_sample_count: PREFERRED_SEND_MIN_EVENTS - 1 },
      globalHour: 9,
    });
    expect(belowThreshold).toEqual({ hourUtc: 9, source: 'global' });
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

describe('logScheduleDistribution', () => {
  // Regression guard for the #3798 code-review cleanup: send-newsletter.mjs's
  // copy of this function used a fixed `{ personal, global }` bySource
  // accumulator that silently dropped any 'fallback-doc' item (job-alerts'
  // copy had it, newsletter's didn't — divergence bug). The shared version
  // builds bySource dynamically from whatever sources it actually sees, so
  // 'fallback-doc' (and any future source) is always tallied.
  it('does not throw and tallies immediate/scheduled/bySource/byHour correctly with mixed sources', () => {
    const items = [
      { scheduledAt: '2026-07-11T09:15:00.000Z', sendTimeSource: 'personal' },
      { scheduledAt: '2026-07-11T09:30:00.000Z', sendTimeSource: 'personal' },
      { scheduledAt: '2026-07-11T20:00:00.000Z', sendTimeSource: 'fallback-doc' },
      { scheduledAt: '2026-07-11T20:05:00.000Z', sendTimeSource: 'global' },
      { scheduledAt: null, sendTimeSource: null },
      { scheduledAt: undefined, sendTimeSource: undefined },
    ];

    let result: ReturnType<typeof logScheduleDistribution>;
    expect(() => {
      result = logScheduleDistribution(items);
    }).not.toThrow();

    expect(result!).toEqual({
      immediate: 2,
      scheduled: 4,
      bySource: { personal: 2, 'fallback-doc': 1, global: 1 },
      byHour: expect.arrayContaining([]),
    });
    expect(result!.byHour[9]).toBe(2);
    expect(result!.byHour[20]).toBe(2);
    expect(result!.byHour.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('supports custom accessors for a nested item shape (send-newsletter.mjs payload/meta)', () => {
    const items = [
      { payload: { scheduledAt: '2026-07-11T14:00:00.000Z' }, meta: { sendTimeSource: 'personal' } },
      { payload: {}, meta: {} },
    ];
    const result = logScheduleDistribution(items, {
      getScheduledAt: (item: any) => item.payload?.scheduledAt,
      getSource: (item: any) => item.meta?.sendTimeSource,
    });
    expect(result).toEqual({
      immediate: 1,
      scheduled: 1,
      bySource: { personal: 1 },
      byHour: expect.any(Array),
    });
    expect(result.byHour[14]).toBe(1);
  });

  it('handles an empty array without throwing', () => {
    expect(() => logScheduleDistribution([])).not.toThrow();
    expect(logScheduleDistribution([])).toEqual({
      immediate: 0,
      scheduled: 0,
      bySource: {},
      byHour: new Array(24).fill(0),
    });
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
