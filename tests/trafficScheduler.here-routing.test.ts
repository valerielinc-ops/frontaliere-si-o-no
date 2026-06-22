/**
 * Tests for HERE Maps routing and TomTom Flow Segment functions.
 *
 * These functions live in functions/src/trafficSchedulerCore.js and are
 * called by the GitHub Actions traffic-scheduler workflow.
 *
 * Why these tests exist:
 * The "fake data shown as real" post-mortem identified that the codebase had
 * no unit tests for individual provider API calls, making silent degradation
 * (wrong URL, broken parsing) invisible until users reported bad data.
 *
 * Covers:
 *  1. getHereMapsRouteTravelTimes — extracts baseDuration / duration from
 *     the HERE Router v8 /routes response.
 *  2. getTomTomFlowSegmentData — computes congestion ratio from
 *     the TomTom Traffic Flow Segment /flowSegmentData response.
 *  3. resolveTrafficProvider priority: TomTom > HERE > Google Maps > null
 *     (TomTom preferred over HERE since #2180 — HERE bills per call and its
 *     free tier is exhausted ~day 6/month; TomTom's free tier covers full demand.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Fetch mock helpers ───────────────────────────────────────────

function mockFetchOnce(body: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function mockFetchError(message: string) {
  global.fetch = vi.fn().mockRejectedValueOnce(new Error(message));
}

// ─── HERE Maps Router v8 ─────────────────────────────────────────

describe('getHereMapsRouteTravelTimes', () => {
  let getHereMapsRouteTravelTimes: (
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    apiKey: string,
  ) => Promise<{ durationNormalSec: number; durationTrafficSec: number }>;

  beforeEach(async () => {
    vi.resetModules();
    ({ getHereMapsRouteTravelTimes } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts baseDuration and duration from a valid HERE response', async () => {
    mockFetchOnce({
      routes: [
        {
          sections: [
            {
              summary: {
                baseDuration: 120, // no-traffic travel time in seconds
                duration: 180,     // with-traffic travel time in seconds
              },
            },
          ],
        },
      ],
    });

    const result = await getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.03, 'test-key');

    expect(result.durationNormalSec).toBe(120);
    expect(result.durationTrafficSec).toBe(180);
  });

  it('includes api key in the request URL', async () => {
    mockFetchOnce({
      routes: [{ sections: [{ summary: { baseDuration: 60, duration: 90 } }] }],
    });

    await getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.03, 'my-here-key');

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('my-here-key');
  });

  it('includes origin and destination coordinates in the URL', async () => {
    mockFetchOnce({
      routes: [{ sections: [{ summary: { baseDuration: 60, duration: 90 } }] }],
    });

    await getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.04, 'key');

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('45.84');
    expect(calledUrl).toContain('9.03');
    expect(calledUrl).toContain('45.85');
    expect(calledUrl).toContain('9.04');
  });

  it('throws when HTTP status is not OK', async () => {
    mockFetchOnce({ title: 'Unauthorized' }, 401);

    await expect(
      getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.03, 'bad-key'),
    ).rejects.toThrow(/401/);
  });

  it('throws when routes array is empty', async () => {
    mockFetchOnce({ routes: [] });

    await expect(
      getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.03, 'key'),
    ).rejects.toThrow();
  });

  it('throws when fetch itself rejects (network error)', async () => {
    mockFetchError('Network failure');

    await expect(
      getHereMapsRouteTravelTimes(45.84, 9.03, 45.85, 9.03, 'key'),
    ).rejects.toThrow('Network failure');
  });
});

// ─── TomTom Traffic Flow Segment ─────────────────────────────────

describe('getTomTomFlowSegmentData', () => {
  let getTomTomFlowSegmentData: (
    lat: number,
    lng: number,
    apiKey: string,
  ) => Promise<{
    ratio: number;
    confidence: number;
    currentSpeed: number;
    freeFlowSpeed: number;
  }>;

  beforeEach(async () => {
    vi.resetModules();
    ({ getTomTomFlowSegmentData } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes ratio = currentSpeed / freeFlowSpeed from a valid response', async () => {
    mockFetchOnce({
      flowSegmentData: {
        currentSpeed: 20,
        freeFlowSpeed: 80,
        confidence: 0.9,
      },
    });

    const result = await getTomTomFlowSegmentData(45.84, 9.03, 'tomtom-key');

    expect(result.ratio).toBeCloseTo(0.25);
    expect(result.confidence).toBe(0.9);
    expect(result.currentSpeed).toBe(20);
    expect(result.freeFlowSpeed).toBe(80);
  });

  it('returns ratio = 1 when traffic matches free-flow speed', async () => {
    mockFetchOnce({
      flowSegmentData: {
        currentSpeed: 80,
        freeFlowSpeed: 80,
        confidence: 1.0,
      },
    });

    const result = await getTomTomFlowSegmentData(45.84, 9.03, 'key');

    expect(result.ratio).toBeCloseTo(1.0);
  });

  it('includes coordinates and api key in request URL', async () => {
    mockFetchOnce({
      flowSegmentData: { currentSpeed: 50, freeFlowSpeed: 100, confidence: 0.8 },
    });

    await getTomTomFlowSegmentData(45.84, 9.03, 'flow-key');

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('45.84');
    expect(calledUrl).toContain('9.03');
    expect(calledUrl).toContain('flow-key');
  });

  it('throws when HTTP status is not OK', async () => {
    mockFetchOnce({ message: 'Too Many Requests' }, 429);

    await expect(
      getTomTomFlowSegmentData(45.84, 9.03, 'key'),
    ).rejects.toThrow(/429/);
  });

  it('throws when flowSegmentData is missing from response', async () => {
    mockFetchOnce({});

    await expect(
      getTomTomFlowSegmentData(45.84, 9.03, 'key'),
    ).rejects.toThrow();
  });

  it('throws on network error', async () => {
    mockFetchError('Connection refused');

    await expect(
      getTomTomFlowSegmentData(45.84, 9.03, 'key'),
    ).rejects.toThrow('Connection refused');
  });
});

// ─── Webcam sanity filter ────────────────────────────────────────

describe('applyWebcamTrafficSanity', () => {
  let applyWebcamTrafficSanity: (
    waitTimeMinutes: number,
    approachMinutes: number,
    webcam: { visibility: string; queueDetected: boolean } | null,
    crossingName?: string,
  ) => number;

  beforeEach(async () => {
    vi.resetModules();
    ({ applyWebcamTrafficSanity } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raises a low provider estimate when a good webcam sees a queue', () => {
    expect(
      applyWebcamTrafficSanity(1, 0, { visibility: 'good', queueDetected: true }, 'Gaggiolo'),
    ).toBe(8);
  });

  it('suppresses a red provider outlier when webcam is clear and approach is free', () => {
    expect(
      applyWebcamTrafficSanity(41, 0, { visibility: 'good', queueDetected: false }, 'Gaggiolo'),
    ).toBe(4);
  });

  it('keeps a high estimate when webcam visibility is not reliable', () => {
    expect(
      applyWebcamTrafficSanity(41, 0, { visibility: 'poor', queueDetected: false }, 'Gaggiolo'),
    ).toBe(41);
  });

  it('keeps a high estimate when the approach segment is also congested', () => {
    expect(
      applyWebcamTrafficSanity(41, 8, { visibility: 'good', queueDetected: false }, 'Gaggiolo'),
    ).toBe(41);
  });
});

// ─── HERE monthly budget guard ───────────────────────────────────

describe('computeHereBudgetDecision', () => {
  let computeHereBudgetDecision: (input: {
    storedMonth?: string;
    storedCount?: number;
    month: string;
    callsThisRun: number;
    budget: number;
  }) => { allowed: boolean; count: number };

  beforeEach(async () => {
    vi.resetModules();
    ({ computeHereBudgetDecision } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
  });

  it('allows the first run of a fresh month (no stored doc)', () => {
    expect(
      computeHereBudgetDecision({ month: '2026-06', callsThisRun: 52, budget: 4500 }),
    ).toEqual({ allowed: true, count: 52 });
  });

  it('accumulates within the same month', () => {
    expect(
      computeHereBudgetDecision({
        storedMonth: '2026-06',
        storedCount: 4000,
        month: '2026-06',
        callsThisRun: 52,
        budget: 4500,
      }),
    ).toEqual({ allowed: true, count: 4052 });
  });

  it('resets the count when the month rolls over', () => {
    expect(
      computeHereBudgetDecision({
        storedMonth: '2026-05',
        storedCount: 4490,
        month: '2026-06',
        callsThisRun: 52,
        budget: 4500,
      }),
    ).toEqual({ allowed: true, count: 52 });
  });

  it('rejects a run that would push the month total over budget', () => {
    expect(
      computeHereBudgetDecision({
        storedMonth: '2026-06',
        storedCount: 4490,
        month: '2026-06',
        callsThisRun: 52,
        budget: 4500,
      }),
    ).toEqual({ allowed: false, count: 4490 });
  });

  it('allows a run that lands exactly on the budget', () => {
    expect(
      computeHereBudgetDecision({
        storedMonth: '2026-06',
        storedCount: 4448,
        month: '2026-06',
        callsThisRun: 52,
        budget: 4500,
      }),
    ).toEqual({ allowed: true, count: 4500 });
  });
});

// ─── resolveTrafficProvider priority ─────────────────────────────

describe('resolveTrafficProvider', () => {
  // Direct priority assertions (function exported since #2180) + indirect
  // verification through fetchCrossingTraffic (which API URL is called).
  //
  // Expected priority: TomTom > HERE > Google Maps > null

  it('prefers TomTom over HERE when both keys are present (#2180 — avoids HERE billing)', async () => {
    const { resolveTrafficProvider } = await import('../functions/src/trafficSchedulerCore.js');
    expect(resolveTrafficProvider({ hereApiKey: 'h', tomtomApiKey: 't' })).toBe('tomtom');
  });

  it('falls back to HERE when only hereApiKey is set', async () => {
    const { resolveTrafficProvider } = await import('../functions/src/trafficSchedulerCore.js');
    expect(resolveTrafficProvider({ hereApiKey: 'h' })).toBe('here');
  });

  it('falls back to Google Maps when only googleApiKey is set; null when no keys', async () => {
    const { resolveTrafficProvider } = await import('../functions/src/trafficSchedulerCore.js');
    expect(resolveTrafficProvider({ googleApiKey: 'g' })).toBe('google-maps');
    expect(resolveTrafficProvider({})).toBe(null);
  });

  let fetchCrossingTraffic: (
    crossing: { name: string; lat: number; lng: number },
    options: { hereApiKey?: string; tomtomApiKey?: string; googleApiKey?: string },
  ) => Promise<{ source: string }>;

  const fakeCrossing = { name: 'Chiasso Centro', lat: 45.84, lng: 9.03 };

  const hereRouteResponse = {
    routes: [{ sections: [{ summary: { baseDuration: 60, duration: 90 } }] }],
  };
  const tomtomRouteResponse = {
    routes: [{ summary: { travelTimeInSeconds: 90, noTrafficTravelTimeInSeconds: 60 } }],
  };

  beforeEach(async () => {
    vi.resetModules();
    ({ fetchCrossingTraffic } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses TomTom when tomtomApiKey is provided alongside hereApiKey (#2180 — HERE billing avoided)', async () => {
    // fetchCrossingTraffic calls two segments → mock fetch twice
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tomtomRouteResponse, text: async () => '' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tomtomRouteResponse, text: async () => '' } as unknown as Response);

    const result = await fetchCrossingTraffic(fakeCrossing, {
      hereApiKey: 'here-key',
      tomtomApiKey: 'tomtom-key',
    });

    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[0] as string,
    );
    // No call must hit the HERE Router endpoint; TomTom is now primary.
    const usedHere = calledUrls.some(url => url.includes('router.hereapi.com') || url.includes('here.com'));
    const usedTomTom = calledUrls.some(url => url.includes('tomtom.com'));
    expect(usedHere).toBe(false);
    expect(usedTomTom).toBe(true);
    expect(result.source).toBe('tomtom');
  });

  it('uses TomTom when only tomtomApiKey is provided', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tomtomRouteResponse, text: async () => '' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => tomtomRouteResponse, text: async () => '' } as unknown as Response);

    const result = await fetchCrossingTraffic(fakeCrossing, { tomtomApiKey: 'tomtom-key' });

    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[0] as string,
    );
    const usedTomTom = calledUrls.some(url => url.includes('tomtom.com'));
    expect(usedTomTom).toBe(true);
    expect(result.source).toBe('tomtom');
  });

  it('throws when no API keys are provided', async () => {
    await expect(
      fetchCrossingTraffic(fakeCrossing, {}),
    ).rejects.toThrow(/no live traffic provider/i);
  });
});

// ─── estimateWaitFromCongestion (webcam score → minutes) ─────────

describe('estimateWaitFromCongestion', () => {
  let estimateWaitFromCongestion: (congestionScore: number | null | undefined) => number;

  beforeEach(async () => {
    vi.resetModules();
    ({ estimateWaitFromCongestion } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 for null / undefined / non-finite scores', () => {
    expect(estimateWaitFromCongestion(null)).toBe(0);
    expect(estimateWaitFromCongestion(undefined)).toBe(0);
    expect(estimateWaitFromCongestion(NaN)).toBe(0);
  });

  it('returns 0 below the 0.40 trust floor', () => {
    expect(estimateWaitFromCongestion(0)).toBe(0);
    expect(estimateWaitFromCongestion(0.39)).toBe(0);
  });

  it('maps 0.40–<0.60 → 8 (light queue)', () => {
    expect(estimateWaitFromCongestion(0.40)).toBe(8);
    expect(estimateWaitFromCongestion(0.5)).toBe(8);
    expect(estimateWaitFromCongestion(0.59)).toBe(8);
  });

  it('maps 0.60–<0.80 → 15 (moderate)', () => {
    expect(estimateWaitFromCongestion(0.60)).toBe(15);
    expect(estimateWaitFromCongestion(0.79)).toBe(15);
  });

  it('maps 0.80–<0.95 → 22 (heavy)', () => {
    expect(estimateWaitFromCongestion(0.80)).toBe(22);
    expect(estimateWaitFromCongestion(0.94)).toBe(22);
  });

  it('caps at 30 for ≥0.95 (saturated frame)', () => {
    expect(estimateWaitFromCongestion(0.95)).toBe(30);
    expect(estimateWaitFromCongestion(1)).toBe(30);
  });

  it('is monotonic non-decreasing across the breakpoints', () => {
    const samples = [0, 0.39, 0.4, 0.59, 0.6, 0.79, 0.8, 0.94, 0.95, 1];
    const outputs = samples.map(estimateWaitFromCongestion);
    for (let i = 1; i < outputs.length; i++) {
      expect(outputs[i]).toBeGreaterThanOrEqual(outputs[i - 1]);
    }
  });

  it('always returns an integer', () => {
    for (const s of [0.4, 0.55, 0.6, 0.81, 0.96]) {
      expect(Number.isInteger(estimateWaitFromCongestion(s))).toBe(true);
    }
  });
});

// ─── Webcam-as-PRIMARY fallback (no live routing data) ───────────

// Mock the dynamically-imported webcam module so the scheduler picks up a
// controllable aggregated verdict without network / sharp / image decoding.
// `vi.hoisted` keeps the spy reachable from the (hoisted) vi.mock factory.
const { webcamVerdict } = vi.hoisted(() => ({ webcamVerdict: vi.fn() }));
vi.mock('../scripts/analyze-webcam-frame.mjs', () => ({
  analyzeWebcamForCrossing: (...args: unknown[]) => webcamVerdict(...args),
}));

describe('fetchCrossingTraffic — webcam as primary source', () => {
  const fakeCrossing = { name: 'Gaggiolo', lat: 45.84, lng: 9.03 };

  let fetchCrossingTraffic: (
    crossing: { name: string; lat: number; lng: number },
    options: {
      hereApiKey?: string;
      tomtomApiKey?: string;
      googleApiKey?: string;
      enableWebcam?: boolean;
    },
  ) => Promise<{ source: string; waitTimeMinutes: number; status: string }>;

  beforeEach(async () => {
    vi.resetModules();
    webcamVerdict.mockReset();
    ({ fetchCrossingTraffic } = await import(
      '../functions/src/trafficSchedulerCore.js'
    ));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the webcam estimate when BOTH HERE segments fail and the cam sees a queue', async () => {
    // Both routing calls reject → no live data.
    global.fetch = vi.fn().mockRejectedValue(new Error('HERE HTTP 503'));
    webcamVerdict.mockResolvedValue({
      congestionScore: 0.85, // heavy → 22 min
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const result = await fetchCrossingTraffic(fakeCrossing, {
      hereApiKey: 'here-key',
      enableWebcam: true,
    });

    expect(result.source).toBe('webcam');
    expect(result.waitTimeMinutes).toBe(22);
    expect(result.status).toBe('red');
  });

  it('still throws (→ mock fallback) when both segments fail and the webcam is unusable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('HERE HTTP 503'));
    webcamVerdict.mockResolvedValue({
      congestionScore: null,
      queueDetected: false,
      visibility: 'night',
      feeds: [],
    });

    await expect(
      fetchCrossingTraffic(fakeCrossing, { hereApiKey: 'here-key', enableWebcam: true }),
    ).rejects.toThrow(/both segments failed/i);
  });

  it('throws when both segments fail and there is no camera for the crossing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('HERE HTTP 503'));
    webcamVerdict.mockResolvedValue(null); // crossing has no CV feed

    await expect(
      fetchCrossingTraffic(fakeCrossing, { hereApiKey: 'here-key', enableWebcam: true }),
    ).rejects.toThrow(/both segments failed/i);
  });

  it('does NOT let the webcam PRIMARY estimate replace a successful HERE estimate', async () => {
    // Both segments succeed: crossing = 18-min delay (1260-180=1080s → 18 min),
    // approach = 0. Webcam reports a saturated frame (score 0.99 → would be 30 min
    // as a PRIMARY estimate). Because the cam is clear of a queue (queueDetected
    // false) the adjust-only sanity path is a no-op here, so the routing value
    // must pass through unchanged — and it must never become the 30-min primary.
    const hereResp = {
      routes: [{ sections: [{ summary: { baseDuration: 180, duration: 1260 } }] }],
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => hereResp, text: async () => '' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ routes: [{ sections: [{ summary: { baseDuration: 60, duration: 60 } }] }] }), text: async () => '' } as unknown as Response);
    webcamVerdict.mockResolvedValue({
      congestionScore: 0.99, // estimateWaitFromCongestion → 30; must be ignored when live data exists
      queueDetected: false,  // keep sanity a no-op so we read the raw routing value
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const result = await fetchCrossingTraffic(fakeCrossing, {
      hereApiKey: 'here-key',
      enableWebcam: true,
    });

    // Source stays the live provider; wait is the routing-derived 18 min, NOT 30.
    expect(result.source).toBe('here');
    expect(result.waitTimeMinutes).toBe(18);
  });
});
