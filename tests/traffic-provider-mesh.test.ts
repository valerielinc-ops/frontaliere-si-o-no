import { describe, expect, it, vi } from 'vitest';
import {
  buildTrafficProviderChain,
  computeProviderBudgetDecision,
  getTrafficSegmentTravelTimes,
  parseProviderBudget,
  providerQuotaDefinition,
  TRAFFIC_PROVIDER_ORDER,
} from '../functions/src/trafficProviderMesh.js';
import { lambert93ToWgs84 } from '../scripts/lib/official-traffic-sources.mjs';

describe('traffic provider mesh', () => {
  it('builds the documented preference chain without exposing key values', () => {
    const chain = buildTrafficProviderChain({
      tomtomApiKey: 'tt',
      hereApiKey: 'here',
      googleRoutesApiKey: 'google',
      mapboxAccessToken: 'mapbox',
      geoapifyApiKey: 'geo',
      openrouteserviceApiKey: 'ors',
      graphhopperApiKey: 'gh',
      stadiaApiKey: 'stadia',
      googleApiKey: 'legacy',
    });

    expect(chain.map((provider) => provider.id)).toEqual(TRAFFIC_PROVIDER_ORDER);
    expect(JSON.stringify(chain)).not.toContain('tt');
    expect(chain.find((provider) => provider.id === 'google-routes')?.budgetScope).toBe('google');
    expect(chain.find((provider) => provider.id === 'google-maps')?.budgetScope).toBe('google');
  });

  it('rejects unsafe budget syntax and accepts strict decimal integers', () => {
    expect(parseProviderBudget('', 12)).toBe(12);
    expect(parseProviderBudget('0x10', 12)).toBe(12);
    expect(parseProviderBudget('1e3', 12)).toBe(12);
    expect(parseProviderBudget('-1', 12)).toBe(12);
    expect(parseProviderBudget('1000', 12)).toBe(1000);
  });

  it('clamps every provider cap to a conservative free-tier ceiling', () => {
    expect(providerQuotaDefinition('tomtom', 'route', {
      TOMTOM_ROUTING_MONTHLY_BUDGET: '999999',
    }).limits[0].budget).toBe(20_000);
    expect(providerQuotaDefinition('here', 'route', {
      HERE_DAILY_BUDGET: '999999',
      HERE_MONTHLY_BUDGET: '999999',
    }).limits.map((limit) => limit.budget)).toEqual([1_000, 4_500]);
    expect(providerQuotaDefinition('opentransportdata', 'traffic-lights', {
      OPENTRANSPORTDATA_QUOTA: '999999',
    })).toMatchObject({
      limits: [{ budget: 260_000 }],
      rateLimit: { maxPerMinute: 5, minIntervalMs: 12_500 },
    });
    expect(providerQuotaDefinition('stadia').unitCost).toBe(20);
  });

  it('rejects an atomic reservation that would cross the cap', () => {
    expect(computeProviderBudgetDecision({
      storedPeriod: '2026-09-15',
      storedCount: 1900,
      period: '2026-09-15',
      callsThisRun: 101,
      budget: 2000,
    })).toEqual({ allowed: false, count: 1900 });
    expect(computeProviderBudgetDecision({
      storedPeriod: '2026-09-14',
      storedCount: 1900,
      period: '2026-09-15',
      callsThisRun: 100,
      budget: 2000,
    })).toEqual({ allowed: true, count: 100 });
  });

  it('fails closed when the persisted counter is corrupted', () => {
    expect(computeProviderBudgetDecision({
      storedPeriod: '2026-09-15',
      storedCount: 'not-a-number',
      period: '2026-09-15',
      callsThisRun: 1,
      budget: 2000,
    })).toEqual({ allowed: false, count: Number.NaN });
    expect(computeProviderBudgetDecision({
      storedPeriod: '2026-09-15',
      storedCount: -1,
      period: '2026-09-15',
      callsThisRun: 1,
      budget: 2000,
    })).toEqual({ allowed: false, count: -1 });
  });

  it('calls Google Routes with a traffic-aware field mask and parses durations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [{ duration: '480s', staticDuration: '180s' }] }),
    });

    await expect(getTrafficSegmentTravelTimes(
      'google-routes',
      45.8,
      9.0,
      45.81,
      9.01,
      { googleRoutesApiKey: 'google-key', fetchImpl: fetchMock },
    )).resolves.toEqual({ durationNormalSec: 180, durationTrafficSec: 480 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('routes.googleapis.com/directions/v2:computeRoutes');
    expect(init.headers['X-Goog-FieldMask']).toContain('routes.staticDuration');
    expect(init.body).toContain('TRAFFIC_AWARE');
  });

  it('uses the Mapbox traffic profile and preserves typical duration as baseline', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [{ duration: 600, duration_typical: 240 }] }),
    });

    await expect(getTrafficSegmentTravelTimes(
      'mapbox',
      45.8,
      9.0,
      45.81,
      9.01,
      { mapboxAccessToken: 'public-token', fetchImpl: fetchMock },
    )).resolves.toEqual({ durationNormalSec: 240, durationTrafficSec: 600 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('driving-traffic');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-token');
  });

  it('checks the reservation before any non-legacy provider fetch', async () => {
    const fetchMock = vi.fn();
    const reserveRequest = vi.fn().mockResolvedValue({ allowed: false, reason: 'quota' });

    await expect(getTrafficSegmentTravelTimes(
      'mapbox',
      45.8,
      9.0,
      45.81,
      9.01,
      {
        mapboxAccessToken: 'mapbox-public',
        fetchImpl: fetchMock,
        providerRuntime: { reserveRequest },
      },
    )).rejects.toMatchObject({ code: 'TRAFFIC_PROVIDER_BUDGET_EXHAUSTED' });
    expect(reserveRequest).toHaveBeenCalledWith('mapbox', 'route');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports static openrouteservice geometry as an honest zero-delay fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{ properties: { summary: { duration: 321 } } }] }),
    });
    await expect(getTrafficSegmentTravelTimes(
      'openrouteservice',
      45.8,
      9.0,
      45.81,
      9.01,
      { openrouteserviceApiKey: 'ors-key', fetchImpl: fetchMock },
    )).resolves.toEqual({ durationNormalSec: 321, durationTrafficSec: 321 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('ors-key');
  });
});

describe('Lambert-93 conversion', () => {
  it('maps a known French Lambert-93 point into France', () => {
    const point = lambert93ToWgs84(651000, 6860000);
    expect(point?.lat).toBeGreaterThan(45);
    expect(point?.lat).toBeLessThan(50);
    expect(point?.lng).toBeGreaterThan(1);
    expect(point?.lng).toBeLessThan(8);
  });
});
