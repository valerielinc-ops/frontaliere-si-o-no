import { describe, expect, it } from 'vitest';
import {
  computePreferredSendHour,
  PREFERRED_SEND_MIN_EVENTS,
  PREFERRED_SEND_WINDOW_DAYS,
} from '../functions/src/lib/preferredSendHour.js';

// Fixed reference "now" — event offsets are always expressed relative to this
// constant (daysAgo), never to the real wall clock, so the suite can't rot
// against a calendar-based stale-prune the way absolute fixture dates would
// (see AGENTS.md "Test fixture: mai date assolute").
const NOW = new Date('2026-07-11T12:00:00.000Z');

function eventAt(daysAgo: number, hourUtc: number, minuteUtc = 0, type: 'open' | 'click' = 'open') {
  const d = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return { type, occurredAt: d };
}

function circularDistance(a: number, b: number) {
  const diff = Math.abs(a - b) % 24;
  return Math.min(diff, 24 - diff);
}

describe('preferredSendHour (functions/src/lib)', () => {
  it('exposes the cold-start threshold and window constants', () => {
    expect(PREFERRED_SEND_MIN_EVENTS).toBe(3);
    expect(PREFERRED_SEND_WINDOW_DAYS).toBe(90);
  });

  it('wraps around midnight using a circular mean, not an arithmetic one', () => {
    // 23:00, 01:00, 00:00 — arithmetic mean would be ~8h; circular mean is ~0h.
    const events = [
      eventAt(1, 23, 0),
      eventAt(1, 1, 0),
      eventAt(1, 0, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(0);
    expect(result.strength).not.toBeNull();
  });

  it('computes a simple concentrated case (~09:xx) as hour 9', () => {
    const events = [
      eventAt(1, 9, 0),
      eventAt(1, 9, 15),
      eventAt(1, 9, 45),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(9);
  });

  it('returns null hourUtc/strength below the cold-start threshold (2 events)', () => {
    const events = [
      eventAt(1, 9, 0),
      eventAt(2, 9, 30),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(2);
    expect(result.hourUtc).toBeNull();
    expect(result.strength).toBeNull();
  });

  it('excludes events older than the 90-day window', () => {
    const events = [
      eventAt(1, 10, 0),
      eventAt(2, 10, 0),
      eventAt(3, 10, 0),
      // 5 stale events well outside the 90-day lookback — must not count.
      eventAt(100, 10, 0),
      eventAt(120, 10, 0),
      eventAt(150, 10, 0),
      eventAt(200, 10, 0),
      eventAt(365, 10, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(10);
  });

  it('weighs recent events more heavily than old ones (recency-dominated result)', () => {
    // 3 recent events (weight 30 each) at 07:00 vs 3 near-90-day-old events
    // (weight 5 each, still <90 so in-window) at 15:00. 07:00 and 15:00 are
    // 8h apart (not antipodal like 08:00/20:00 would be), so the recent
    // cluster should pull the circular mean noticeably closer to 7 than 15,
    // even though it won't land exactly on 7 (the old cluster still
    // contributes some pull).
    const events = [
      eventAt(1, 7, 0),
      eventAt(2, 7, 0),
      eventAt(3, 7, 0),
      eventAt(85, 15, 0),
      eventAt(85, 15, 0),
      eventAt(85, 15, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(6);
    expect(result.hourUtc).not.toBeNull();
    expect(circularDistance(result.hourUtc as number, 7)).toBeLessThan(circularDistance(result.hourUtc as number, 15));
  });

  it('accepts mixed input formats: ISO string, Date, and Firestore-Timestamp-like', () => {
    const isoEvent = { type: 'open' as const, occurredAt: eventAt(1, 9, 0).occurredAt.toISOString() };
    const dateEvent = eventAt(1, 9, 10);
    const timestampLikeEvent = {
      type: 'click' as const,
      occurredAt: { toDate: () => eventAt(1, 9, 20).occurredAt },
    };
    const result = computePreferredSendHour([isoEvent, dateEvent, timestampLikeEvent], NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(9);
  });

  it('discards non-parsable event dates instead of throwing', () => {
    const events = [
      eventAt(1, 9, 0),
      eventAt(1, 9, 10),
      eventAt(1, 9, 20),
      { type: 'open' as const, occurredAt: 'not-a-date' },
      { type: 'open' as const, occurredAt: null },
      { type: 'send' as const, occurredAt: eventAt(1, 9, 0).occurredAt }, // wrong type, also discarded
    ];
    const result = computePreferredSendHour(events as never, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(9);
  });

  it('reports strength near 1 when all events cluster at the same hour', () => {
    const events = [
      eventAt(1, 9, 0),
      eventAt(2, 9, 0),
      eventAt(3, 9, 0),
      eventAt(4, 9, 0),
      eventAt(5, 9, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.strength).toBeGreaterThan(0.99);
  });

  it('reports strength near 0 when events are spread evenly across the day', () => {
    // Four equally-weighted events at opposite hours (0, 6, 12, 18) cancel
    // out almost entirely in the circular mean — no real preference.
    const events = [
      eventAt(1, 0, 0),
      eventAt(1, 6, 0),
      eventAt(1, 12, 0),
      eventAt(1, 18, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(4);
    expect(typeof result.hourUtc).toBe('number');
    expect(result.strength as number).toBeLessThan(0.01);
  });

  it('rounds an hour fraction of 23.6 up to 24 and wraps to 0', () => {
    // A tight cluster at 23:36 UTC (23.6h) — the circular mean lands
    // essentially exactly on that fraction, exercising the Math.round(23.6)
    // === 24 → mod 24 === 0 wraparound path explicitly.
    const events = [
      eventAt(1, 23, 36),
      eventAt(2, 23, 36),
      eventAt(3, 23, 36),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.hourUtc).toBe(0);
  });

  it('treats click events the same as open events', () => {
    const events = [
      eventAt(1, 14, 0, 'click'),
      eventAt(2, 14, 0, 'click'),
      eventAt(3, 14, 0, 'open'),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(14);
  });

  it('handles an empty/non-array input gracefully', () => {
    expect(computePreferredSendHour([], NOW)).toEqual({ hourUtc: null, sampleCount: 0, strength: null });
    expect(computePreferredSendHour(undefined as never, NOW)).toEqual({ hourUtc: null, sampleCount: 0, strength: null });
  });
});
