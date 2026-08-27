import { describe, expect, it } from 'vitest';
import {
  circularMeanToHour,
  computePreferredSendHour,
  PREFERRED_SEND_MIN_EVENTS,
  PREFERRED_SEND_REFRESH_INTERVAL_MS,
  PREFERRED_SEND_WINDOW_DAYS,
  refreshPreferredSendHour,
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

// Minimal fake subscriberRef for testing refreshPreferredSendHour's staleness
// gate directly, without going through a full webhook-core fake db. Tracks
// whether the `events` subcollection was ever queried and what was written,
// so gate tests can assert "no query / no write" precisely.
function createFakeSubscriberRef({
  docData = null as Record<string, unknown> | null,
  events = [] as Array<Record<string, unknown>>,
} = {}) {
  const sets: Array<{ data: Record<string, unknown>; opts?: unknown }> = [];
  let eventsQueried = false;
  const ref = {
    get: async () => ({ exists: !!docData, data: () => docData }),
    set: async (data: Record<string, unknown>, opts?: unknown) => {
      sets.push({ data, opts });
    },
    collection: (name: string) => {
      if (name !== 'events') throw new Error(`unexpected subcollection: ${name}`);
      return {
        orderBy: () => ({
          limit: () => ({
            get: async () => {
              eventsQueried = true;
              return { docs: events.map((d) => ({ data: () => d })) };
            },
          }),
        }),
      };
    },
  };
  return { ref, sets, wasEventsQueried: () => eventsQueried };
}

function fakeFieldValue() {
  return { serverTimestamp: () => 'SERVER_TIMESTAMP', increment: (n: number) => ({ __increment: n }) };
}

function firestoreEventAt(daysAgo: number, hourUtc: number) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return { event_type: 'open', occurred_at: d.toISOString() };
}

describe('preferredSendHour (functions/src/lib)', () => {
  it('exposes the cold-start threshold and window constants', () => {
    expect(PREFERRED_SEND_MIN_EVENTS).toBe(3);
    expect(PREFERRED_SEND_WINDOW_DAYS).toBe(180);
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

  it('includes 90-180 day-old events at low tail weight, excludes anything past 180 days', () => {
    const events = [
      eventAt(1, 10, 0),
      eventAt(2, 10, 0),
      eventAt(3, 10, 0),
      // Inside the 90-180 day tail bucket (added 2026-08-25, weight 2) — must count.
      eventAt(100, 10, 0),
      eventAt(120, 10, 0),
      eventAt(150, 10, 0),
      // Past the 180-day window — must not count.
      eventAt(200, 10, 0),
      eventAt(365, 10, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(6);
    expect(result.hourUtc).toBe(10);
  });

  it('excludes events older than the 180-day window', () => {
    const events = [
      eventAt(1, 10, 0),
      eventAt(2, 10, 0),
      eventAt(3, 10, 0),
      // 2 stale events past the window — must not count.
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
      eventAt(1.25, 6, 0),
      eventAt(1.5, 12, 0),
      eventAt(1.75, 18, 0),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(4);
    expect(typeof result.hourUtc).toBe('number');
    // Continuous recency weighting means these events are not mathematically
    // identical in weight, but their vectors should still nearly cancel out.
    expect(result.strength as number).toBeLessThan(0.05);
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

  it('counts clicks as stronger intent when events have the same recency', () => {
    const events = [
      eventAt(1, 14, 0, 'click'),
      eventAt(2, 14, 0, 'click'),
      eventAt(3, 14, 0, 'open'),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(result.hourUtc).toBe(14);
  });

  it('lets a recent open outweigh a much older click', () => {
    const events = [
      eventAt(10, 18, 0, 'click'),
      eventAt(1, 8, 0, 'open'),
      eventAt(1, 8, 0, 'open'),
    ];
    const result = computePreferredSendHour(events, NOW);
    expect(result.sampleCount).toBe(3);
    expect(circularDistance(result.hourUtc as number, 8)).toBeLessThan(
      circularDistance(result.hourUtc as number, 18),
    );
  });

  it('handles an empty/non-array input gracefully', () => {
    expect(computePreferredSendHour([], NOW)).toEqual({ hourUtc: null, sampleCount: 0, strength: null });
    expect(computePreferredSendHour(undefined as never, NOW)).toEqual({ hourUtc: null, sampleCount: 0, strength: null });
  });
});

describe('circularMeanToHour (functions/src/lib) — shared angle→hour conversion (#3798)', () => {
  it('converts angle 0 (sin=0, cos=1) to hour 0', () => {
    expect(circularMeanToHour(0, 1)).toBe(0);
  });

  it('converts a 90° angle (sin=1, cos=0) to hour 6', () => {
    expect(circularMeanToHour(1, 0)).toBe(6);
  });

  it('wraps a negative atan2 angle (sin=-1, cos=0, i.e. -90°) to hour 18', () => {
    // atan2(-1, 0) = -π/2 — exercises the `if (hourFloat < 0) hourFloat += 24` branch.
    expect(circularMeanToHour(-1, 0)).toBe(18);
  });

  it('rounds an hour fraction of 23.6 up to 24 and wraps to 0', () => {
    const theta = (2 * Math.PI * 23.6) / 24;
    expect(circularMeanToHour(Math.sin(theta), Math.cos(theta))).toBe(0);
  });
});

describe('refreshPreferredSendHour — staleness gate (#3798 code review)', () => {
  it('exposes the refresh interval constant (6 hours)', () => {
    expect(PREFERRED_SEND_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('skips the events query and write when sample_count >= threshold and updated_at is fresh (<6h)', async () => {
    const freshDate = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const { ref, sets, wasEventsQueried } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 5,
        preferred_send_hour_utc: 9,
        preferred_send_strength: 0.8,
        preferred_send_updated_at: freshDate,
      },
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(wasEventsQueried()).toBe(false);
    expect(sets.length).toBe(0);
    expect(result).toEqual({ updated: false, hourUtc: 9, sampleCount: 5, strength: 0.8 });
  });

  it('does NOT gate below the cold-start threshold, even with a fresh updated_at', async () => {
    const freshDate = new Date(Date.now() - 60 * 60 * 1000);
    const { ref, sets, wasEventsQueried } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 2,
        preferred_send_hour_utc: null,
        preferred_send_strength: null,
        preferred_send_updated_at: freshDate,
      },
      events: [],
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(wasEventsQueried()).toBe(true);
    expect(sets.length).toBe(1);
    expect(result.updated).toBe(true);
  });

  it('re-runs the query and write once updated_at is older than the refresh interval (>6h)', async () => {
    const staleDate = new Date(Date.now() - (PREFERRED_SEND_REFRESH_INTERVAL_MS + 60 * 60 * 1000));
    const { ref, sets, wasEventsQueried } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 5,
        preferred_send_hour_utc: 9,
        preferred_send_strength: 0.8,
        preferred_send_updated_at: staleDate,
      },
      events: [
        { event_type: 'open', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
        { event_type: 'open', occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { event_type: 'open', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() },
      ],
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(wasEventsQueried()).toBe(true);
    expect(sets.length).toBe(1);
    expect(result.updated).toBe(true);
    expect(result.sampleCount).toBe(3);
  });

  it('is tolerant of a Firestore-Timestamp-like preferred_send_updated_at (fresh → gates)', async () => {
    const freshDate = new Date(Date.now() - 60 * 60 * 1000);
    const { ref, wasEventsQueried } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 4,
        preferred_send_hour_utc: 10,
        preferred_send_strength: 0.5,
        preferred_send_updated_at: { toDate: () => freshDate },
      },
    });

    await refreshPreferredSendHour(ref as never, fakeFieldValue());
    expect(wasEventsQueried()).toBe(false);
  });

  it('is tolerant of an ISO-string preferred_send_updated_at (stale → re-runs)', async () => {
    const staleIso = new Date(Date.now() - (PREFERRED_SEND_REFRESH_INTERVAL_MS + 1000)).toISOString();
    const { ref, wasEventsQueried } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 4,
        preferred_send_hour_utc: 10,
        preferred_send_strength: 0.5,
        preferred_send_updated_at: staleIso,
      },
      events: [],
    });

    await refreshPreferredSendHour(ref as never, fakeFieldValue());
    expect(wasEventsQueried()).toBe(true);
  });

  it('does not gate when the subscriber doc does not exist yet', async () => {
    const { ref, wasEventsQueried } = createFakeSubscriberRef({ docData: null, events: [] });
    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());
    expect(wasEventsQueried()).toBe(true);
    expect(result.updated).toBe(true);
  });
});

describe('refreshPreferredSendHour — churn instrumentation (#3798 Fix MEDIO-BASSO #6)', () => {
  it('increments preferred_send_hour_churn_count when the newly computed hour differs from the stored one', async () => {
    const staleDate = new Date(Date.now() - (PREFERRED_SEND_REFRESH_INTERVAL_MS + 60 * 60 * 1000));
    const { ref, sets } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 5,
        preferred_send_hour_utc: 9,
        preferred_send_strength: 0.8,
        preferred_send_updated_at: staleDate,
      },
      events: [firestoreEventAt(1, 14), firestoreEventAt(2, 14), firestoreEventAt(3, 14)],
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(result.hourUtc).toBe(14);
    expect(result.churned).toBe(true);
    expect(sets[0].data.preferred_send_hour_churn_count).toEqual({ __increment: 1 });
  });

  it('does not increment when the newly computed hour matches the stored one', async () => {
    const staleDate = new Date(Date.now() - (PREFERRED_SEND_REFRESH_INTERVAL_MS + 60 * 60 * 1000));
    const { ref, sets } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 5,
        preferred_send_hour_utc: 14,
        preferred_send_strength: 0.8,
        preferred_send_updated_at: staleDate,
      },
      events: [firestoreEventAt(1, 14), firestoreEventAt(2, 14), firestoreEventAt(3, 14)],
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(result.hourUtc).toBe(14);
    expect(result.churned).toBe(false);
    expect(sets[0].data.preferred_send_hour_churn_count).toBeUndefined();
  });

  it('does not count the first assignment (null → hour) as churn', async () => {
    const { ref, sets } = createFakeSubscriberRef({
      docData: {
        preferred_send_sample_count: 2,
        preferred_send_hour_utc: null,
        preferred_send_strength: null,
        preferred_send_updated_at: new Date(),
      },
      events: [firestoreEventAt(1, 14), firestoreEventAt(2, 14), firestoreEventAt(3, 14)],
    });

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(result.hourUtc).toBe(14);
    expect(result.churned).toBe(false);
    expect(sets[0].data.preferred_send_hour_churn_count).toBeUndefined();
  });
});

// Gap flagged by #3798 code review: the catch block (mirrors refreshEngagementScore's
// swallow-and-console.warn idiom) had no direct test forcing it to actually execute.
// Both possible throw sites inside the try are exercised separately: the initial
// subscriberRef.get() (staleness-gate read) and the events subcollection query.
describe('refreshPreferredSendHour — error handling (catch path, #3798 code review)', () => {
  it('swallows a thrown error from subscriberRef.get() and returns { updated: false } without writing', async () => {
    const sets: Array<{ data: unknown; opts?: unknown }> = [];
    const ref = {
      get: async () => {
        throw new Error('boom-get');
      },
      set: async (data: unknown, opts?: unknown) => {
        sets.push({ data, opts });
      },
      collection: () => {
        throw new Error('should not reach the events collection when get() already threw');
      },
    };

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(result).toEqual({ updated: false });
    expect(sets.length).toBe(0);
  });

  it('swallows a thrown error from the events subcollection query and returns { updated: false } without writing', async () => {
    const sets: Array<{ data: unknown; opts?: unknown }> = [];
    const ref = {
      get: async () => ({ exists: false, data: () => null }),
      set: async (data: unknown, opts?: unknown) => {
        sets.push({ data, opts });
      },
      collection: (name: string) => {
        if (name !== 'events') throw new Error(`unexpected subcollection: ${name}`);
        return {
          orderBy: () => ({
            limit: () => ({
              get: async () => {
                throw new Error('boom-events-query');
              },
            }),
          }),
        };
      },
    };

    const result = await refreshPreferredSendHour(ref as never, fakeFieldValue());

    expect(result).toEqual({ updated: false });
    expect(sets.length).toBe(0);
  });
});
