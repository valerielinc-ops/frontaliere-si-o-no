/**
 * Tests for services/borderWaitFormat.ts's minutesSince() helper, added for
 * the border-wait popup freshness indicator (issue #4892). All fixtures use
 * offsets relative to a fixed `nowMs` (never a hardcoded absolute date) so
 * the test never rots as the calendar moves forward.
 */

import { describe, expect, it } from 'vitest';
import { minutesSince } from '../services/borderWaitFormat';

// Fixed reference instant for the whole file — arbitrary, only used as a
// relative anchor for offsets below, never asserted against a real calendar date.
const NOW_MS = Date.now();

describe('minutesSince', () => {
  it('returns 0 for a timestamp equal to now', () => {
    expect(minutesSince(new Date(NOW_MS).toISOString(), NOW_MS)).toBe(0);
  });

  it('returns whole minutes elapsed for a timestamp in the past', () => {
    const twelveMinutesAgo = new Date(NOW_MS - 12 * 60 * 1000).toISOString();
    expect(minutesSince(twelveMinutesAgo, NOW_MS)).toBe(12);
  });

  it('rounds to the nearest whole minute', () => {
    const almostTwoMinutes = new Date(NOW_MS - (2 * 60 * 1000 - 10 * 1000)).toISOString(); // 1m50s ago
    expect(minutesSince(almostTwoMinutes, NOW_MS)).toBe(2);
  });

  it('clamps a future (clock-skewed) timestamp to 0, never negative', () => {
    const inTheFuture = new Date(NOW_MS + 5 * 60 * 1000).toISOString();
    expect(minutesSince(inTheFuture, NOW_MS)).toBe(0);
  });

  it('returns null for null/undefined/empty input', () => {
    expect(minutesSince(null, NOW_MS)).toBeNull();
    expect(minutesSince(undefined, NOW_MS)).toBeNull();
    expect(minutesSince('', NOW_MS)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(minutesSince('not-a-date', NOW_MS)).toBeNull();
  });

  it('defaults nowMs to Date.now() when omitted', () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(minutesSince(oneMinuteAgo)).toBe(1);
  });
});
