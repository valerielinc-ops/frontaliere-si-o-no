import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCrossingTraffic } from '../functions/src/trafficSchedulerCore.js';
import {
  buildTrafficProviderChain,
  isTransientProviderRefusal,
  providerBudgetExhaustedError,
} from '../functions/src/trafficProviderMesh.js';

const CHIASSO = { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 };

/**
 * Regression guard for the 2026-09-18 outage (run 35358498994): three mapbox
 * reservations failed with Firestore `10 ABORTED: cross-transaction
 * contention`, the runtime read that as a spent allowance and banned mapbox —
 * the only provider that actually serves all 141 crossings — for the rest of
 * the run. The chain then collapsed onto its exhausted/misconfigured fallbacks
 * and 114 of 141 crossings ended with `No live traffic provider available`.
 */
describe('transient reservation refusals do not ban a provider for the run', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies a contention refusal as transient and a spent budget as not', () => {
    expect(isTransientProviderRefusal(
      providerBudgetExhaustedError('mapbox', undefined, undefined, 'quota-check-failed'),
    )).toBe(true);
    expect(isTransientProviderRefusal(
      providerBudgetExhaustedError('mapbox', 5000, '2026-09', 'rate-limit'),
    )).toBe(true);
    expect(isTransientProviderRefusal(
      providerBudgetExhaustedError('mapbox', 5000, '2026-09', 'quota'),
    )).toBe(false);
  });

  it('keeps the provider eligible after the contended segment', async () => {
    const options = {
      mapboxAccessToken: 'mapbox-public',
      providerChain: buildTrafficProviderChain({ mapboxAccessToken: 'mapbox-public' }),
      enableWebcam: false,
    };
    const disabled = new Set<string>();
    let reservations = 0;
    // Refuse the first reservation the way a Firestore contention abort does,
    // then behave normally — exactly the 3-in-282 rate seen in the real run.
    const providerRuntime = {
      disabled,
      ensureProvider: async (id: string) => !disabled.has(id),
      reserveRequest: async () => {
        reservations += 1;
        return reservations === 1
          ? { allowed: false, reason: 'quota-check-failed' }
          : { allowed: true };
      },
    };

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ routes: [{ duration: 300, legs: [{ annotation: { duration: [300] } }] }] }),
    }) as unknown as Response));

    // Both segments of the crossing are attempted concurrently, so the first
    // one eats the refusal. The crossing still resolves from the other one…
    const first = await fetchCrossingTraffic(CHIASSO, { ...options, providerRuntime });
    expect(first.source).toBe('mapbox');
    // …and, decisively, mapbox is still in the chain for the next crossing.
    expect([...disabled]).toEqual([]);

    const second = await fetchCrossingTraffic(CHIASSO, { ...options, providerRuntime });
    expect(second.source).toBe('mapbox');
    expect([...disabled]).toEqual([]);
  });

  it('still bans a provider whose allowance is genuinely spent', async () => {
    const disabled = new Set<string>();
    const providerRuntime = {
      disabled,
      ensureProvider: async (id: string) => !disabled.has(id),
      reserveRequest: async () => ({ allowed: false, reason: 'quota', budget: 5000, period: '2026-09' }),
    };

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch must never be reached once the reservation is refused');
    }));

    await expect(fetchCrossingTraffic(CHIASSO, {
      mapboxAccessToken: 'mapbox-public',
      providerChain: buildTrafficProviderChain({ mapboxAccessToken: 'mapbox-public' }),
      enableWebcam: false,
      providerRuntime,
    })).rejects.toThrow(/Both segments failed/);
    expect([...disabled]).toEqual(['mapbox']);
  });

  it('names the banned providers instead of a blind "nothing available"', async () => {
    const disabled = new Set<string>(['mapbox']);
    await expect(fetchCrossingTraffic(CHIASSO, {
      mapboxAccessToken: 'mapbox-public',
      providerChain: buildTrafficProviderChain({ mapboxAccessToken: 'mapbox-public' }),
      enableWebcam: false,
      providerRuntime: { disabled, ensureProvider: async (id: string) => !disabled.has(id) },
    })).rejects.toThrow(/No live traffic provider available \(all providers disabled for this run: mapbox\)/);
  });
});

describe('stadia adapter speaks Valhalla, not OSRM', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to /route/v1 and reads trip.summary.time', async () => {
    // The OSRM-style GET this replaces answered HTTP 404 on every segment.
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      expect(String(url)).toBe('https://api.stadiamaps.com/route/v1?api_key=stadia-key');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({
        locations: [{ lat: 45.8409, lon: 9.0376 }, { lat: 45.8509, lon: 9.0376 }],
        costing: 'auto',
      });
      return { ok: true, json: async () => ({ trip: { summary: { time: 420 } } }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getTrafficSegmentTravelTimes } = await import('../functions/src/trafficProviderMesh.js');
    const times = await getTrafficSegmentTravelTimes(
      'stadia',
      45.8409,
      9.0376,
      45.8509,
      9.0376,
      { stadiaApiKey: 'stadia-key' },
    );
    expect(times).toEqual({ durationNormalSec: 420, durationTrafficSec: 420 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Reviewer finding on PR #9143 L667: converting EVERY thrown reservation error
 * into `quota-check-failed` swapped one wrong absolute for another — a
 * permission or configuration fault would be retried once per segment for all
 * 141 crossings instead of rotating away once.
 */
describe('a permanent reservation failure still disables the provider', () => {
  it('separates retryable Firestore codes from configuration faults', async () => {
    const { isRetryableReservationError } = await import('../functions/src/trafficProviderMesh.js');
    const withCode = (code: number, message = 'boom') => Object.assign(new Error(message), { code });

    // ABORTED (contention — the 2026-09-18 outage), UNAVAILABLE, INTERNAL,
    // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED: another attempt can succeed.
    for (const code of [4, 8, 10, 13, 14]) {
      expect(isRetryableReservationError(withCode(code))).toBe(true);
    }
    // PERMISSION_DENIED, UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND,
    // FAILED_PRECONDITION: identical on every remaining segment.
    for (const code of [3, 5, 7, 9, 16]) {
      expect(isRetryableReservationError(withCode(code))).toBe(false);
    }
    // The real shape from the outage log, with the numeric code lost by a
    // wrapper but the gax message prefix intact.
    expect(isRetryableReservationError(
      new Error('10 ABORTED: Aborted due to cross-transaction contention.'),
    )).toBe(true);
    expect(isRetryableReservationError(
      new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.'),
    )).toBe(false);
    // Unclassifiable → treated as permanent: an error nobody can read, retried
    // once per segment, is the stall this guard exists to avoid.
    expect(isRetryableReservationError(new Error('something odd'))).toBe(false);
    expect(isRetryableReservationError(undefined)).toBe(false);
  });
});

/**
 * Reviewer findings on PR #9143 L716 and L759: the Firestore write and the
 * collector's exit code have to obey ONE rule, and a run that collected
 * nothing must never read as success.
 */
describe('publishability is one rule for persistence and exit code', () => {
  it('refuses a run that collected nothing, whatever errors says', async () => {
    const { runIsPublishable } = await import('../functions/src/trafficSchedulerCore.js');
    // The provider-mesh-exhausted and no-provider paths both report 0/0.
    expect(runIsPublishable(0, 0)).toBe(false);
    expect(runIsPublishable(0, 141)).toBe(false);
  });

  it('draws the line at the same 50% the collector exits on', async () => {
    const { runIsPublishable, MAX_CROSSING_FAILURE_RATE } = await import('../functions/src/trafficSchedulerCore.js');
    expect(MAX_CROSSING_FAILURE_RATE).toBe(0.5);
    expect(runIsPublishable(141, 0)).toBe(true);   // the healthy run
    expect(runIsPublishable(27, 114)).toBe(false); // the 2026-09-18 outage
    expect(runIsPublishable(71, 70)).toBe(true);   // 49.6% — publishable
    expect(runIsPublishable(70, 70)).toBe(true);   // exactly 50% — still in
    expect(runIsPublishable(69, 72)).toBe(false);  // 51.1% — out
  });
});
