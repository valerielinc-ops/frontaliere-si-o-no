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
 *  3. resolveTrafficProvider priority: HERE > TomTom > Google Maps > null
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

// ─── resolveTrafficProvider priority ─────────────────────────────

describe('resolveTrafficProvider', () => {
  // resolveTrafficProvider is currently private inside trafficSchedulerCore.js;
  // we verify the priority indirectly through runTrafficCollection / fetchCrossingTraffic
  // by inspecting which API URL gets called when multiple keys are present.
  //
  // Expected priority: HERE > TomTom > Google Maps > null

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

  it('uses HERE when hereApiKey is provided alongside tomtomApiKey', async () => {
    // fetchCrossingTraffic calls two segments → mock fetch twice
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => hereRouteResponse, text: async () => '' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => hereRouteResponse, text: async () => '' } as unknown as Response);

    const result = await fetchCrossingTraffic(fakeCrossing, {
      hereApiKey: 'here-key',
      tomtomApiKey: 'tomtom-key',
    });

    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[0] as string,
    );
    // At least one call must be to the HERE Router endpoint, not TomTom Routing
    const usedHere = calledUrls.some(url => url.includes('router.hereapi.com') || url.includes('here.com'));
    expect(usedHere).toBe(true);
    expect(result.source).toBe('here');
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
