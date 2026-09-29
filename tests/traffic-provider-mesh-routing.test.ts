import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCrossingTraffic } from '../functions/src/trafficSchedulerCore.js';
import { buildTrafficProviderChain } from '../functions/src/trafficProviderMesh.js';

describe('traffic provider rotation at crossing level', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses one route request for a static provider because it cannot measure approach delay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ paths: [{ time: 240_000 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCrossingTraffic(
      { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
      {
        graphhopperApiKey: 'graphhopper-key',
        providerChain: buildTrafficProviderChain({ graphhopperApiKey: 'graphhopper-key' }),
        enableWebcam: false,
      },
    );

    expect(result.source).toBe('graphhopper');
    expect(result.waitTimeMinutes).toBe(0);
    expect(result.approachMinutes).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rotates from a 429 Mapbox segment to openrouteservice', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('mapbox.com')) {
        return { ok: false, status: 429, text: async () => 'rate limit' } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ features: [{ properties: { summary: { duration: 240 } } }] }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCrossingTraffic(
      { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
      {
        mapboxAccessToken: 'mapbox-public',
        openrouteserviceApiKey: 'ors-key',
        providerChain: buildTrafficProviderChain({ mapboxAccessToken: 'mapbox-public', openrouteserviceApiKey: 'ors-key' }),
        enableWebcam: false,
      },
    );

    expect(result.source).toBe('openrouteservice');
    expect(result.waitTimeMinutes).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('mapbox.com'))).toHaveLength(1);
  });

  it('skips the approach after a traffic-aware failure falls back to GraphHopper', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.includes('mapbox.com')) {
        return { ok: false, status: 429, text: async () => 'rate limit' } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ paths: [{ time: 240_000 }] }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const disabled = new Set<string>();
    const result = await fetchCrossingTraffic(
      { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
      {
        mapboxAccessToken: 'mapbox-public',
        graphhopperApiKey: 'graphhopper-key',
        providerChain: buildTrafficProviderChain({
          mapboxAccessToken: 'mapbox-public',
          graphhopperApiKey: 'graphhopper-key',
        }),
        providerRuntime: {
          disabled,
          ensureProvider: async (providerId: string) => !disabled.has(providerId),
          reserveRequest: async () => ({ allowed: true }),
        },
        enableWebcam: false,
      },
    );

    expect(result.source).toBe('graphhopper');
    expect(result.approachMinutes).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('mapbox.com'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('graphhopper.com'))).toHaveLength(1);
  });

  it('uses the fallback chain for the approach when the crossing fails', async () => {
    const crossingLat = 45.8409;
    const crossingLng = 9.0376;
    const crossingStart = `${crossingLat},${crossingLng}`;
    const crossingEnd = `${crossingLat + 0.01},${crossingLng}`;
    const approachStart = `${crossingLat - 0.0045},${crossingLng}`;
    const fetchMock = vi.fn(async (url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.includes('mapbox.com')) {
        return { ok: false, status: 503, text: async () => 'crossing unavailable' } as unknown as Response;
      }
      if (requestUrl.includes('graphhopper.com')) {
        const points = new URL(requestUrl).searchParams.getAll('point');
        if (points[0] === crossingStart && points[1] === crossingEnd) {
          return { ok: false, status: 503, text: async () => 'crossing unavailable' } as unknown as Response;
        }
        if (points[0] !== approachStart || points[1] !== crossingStart) {
          throw new Error(`unexpected GraphHopper segment: ${points.join(' → ')}`);
        }
        return {
          ok: true,
          json: async () => ({ paths: [{ time: 240_000 }] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected provider request: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCrossingTraffic(
      { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
      {
        mapboxAccessToken: 'mapbox-public',
        graphhopperApiKey: 'graphhopper-key',
        providerChain: buildTrafficProviderChain({
          mapboxAccessToken: 'mapbox-public',
          graphhopperApiKey: 'graphhopper-key',
        }),
        enableWebcam: false,
      },
    );

    expect(result.source).toBe('graphhopper');
    expect(result.approachMinutes).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('graphhopper.com'))).toHaveLength(2);
  });

  it('keeps an explicit official queue as a lower bound over a clear route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [{ summary: { travelTimeInSeconds: 120, noTrafficTravelTimeInSeconds: 120 } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCrossingTraffic(
      { name: 'Bardonnex', lat: 46.1495357, lng: 6.0960713 },
      {
        tomtomApiKey: 'tomtom-key',
        officialSignals: {
          bardonnex: { queueMinutes: 12, queueKm: 3, sourceIds: ['fr-atmb-bulletin'] },
        },
        enableWebcam: false,
      },
    );

    expect(result.waitTimeMinutes).toBe(12);
    expect(result.source).toBe('tomtom');
    expect(result.officialSources).toBe('fr-atmb-bulletin');
    expect(result.officialQueueKm).toBe(3);
    expect(result.dataQuality).toBe('live+official');
  });
});
