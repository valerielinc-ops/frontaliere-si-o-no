import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCrossingTraffic } from '../functions/src/trafficSchedulerCore.js';
import { buildTrafficProviderChain } from '../functions/src/trafficProviderMesh.js';

describe('traffic provider rotation at crossing level', () => {
  afterEach(() => vi.unstubAllGlobals());

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
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('mapbox.com'))).toHaveLength(2);
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
