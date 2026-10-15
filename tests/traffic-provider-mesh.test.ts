import { describe, expect, it, vi } from 'vitest';
import {
  assessWebcamWaitBaseline,
  buildTrafficProviderChain,
  computeProviderBudgetDecision,
  estimateWebcamWait,
  getTrafficSegmentTravelTimes,
  parseProviderBudget,
  providerQuotaDefinition,
  TRAFFIC_PROVIDER_SPECS,
  TRAFFIC_PROVIDER_ORDER,
} from '../functions/src/trafficProviderMesh.js';
import { HERE_MONTHLY_FREE_TIER_BUDGET } from '../functions/src/lib/hereBudget.js';
import { lambert93ToWgs84 } from '../scripts/lib/official-traffic-sources.mjs';

describe('traffic provider mesh', () => {
  it('keeps the webcam estimator unknown until a three-feed, zero-cost baseline is validated', () => {
    expect(estimateWebcamWait(0.7)).toEqual({
      status: 'unknown',
      waitTimeMinutes: null,
      reason: 'baseline-not-validated',
    });
    expect(estimateWebcamWait(null, {
      validated: true,
      feedCount: 2,
      coverage: 1,
      maeMinutes: 1,
      maxAbsoluteErrorMinutes: 2,
      incrementalPaidRequests: 0,
      intercept: 1,
      slope: 10,
    }).status).toBe('unknown');
  });

  it('accepts a measured three-feed baseline and enforces the estimator cap', () => {
    const observations = [
      { feedKey: 'feed-a', provider: 'tomtom', congestionScore: 0.2, vehicleCount: 2, providerWaitMinutes: 5, candidateWaitMinutes: 5, observedAt: '2026-10-15T06:00:00.000Z', incrementalPaidRequests: 0 },
      { feedKey: 'feed-b', provider: 'here', congestionScore: 0.5, vehicleCount: 5, providerWaitMinutes: 10, candidateWaitMinutes: 10, observedAt: '2026-10-15T06:00:00.000Z', incrementalPaidRequests: 0 },
      { feedKey: 'feed-c', provider: 'tomtom', congestionScore: 0.8, vehicleCount: 8, providerWaitMinutes: 15, candidateWaitMinutes: 15, observedAt: '2026-10-15T06:00:00.000Z', incrementalPaidRequests: 0 },
    ];
    const baseline = assessWebcamWaitBaseline(observations);
    expect(baseline.ready).toBe(true);
    expect(baseline.metrics).toMatchObject({ feedCount: 3, validPairs: 3, incrementalPaidRequests: 0, maeMinutes: 0 });

    expect(estimateWebcamWait(0.9, {
      validated: true,
      feedCount: 3,
      coverage: 1,
      maeMinutes: 2,
      maxAbsoluteErrorMinutes: 4,
      incrementalPaidRequests: 0,
      intercept: 5,
      slope: 40,
      capMinutes: 30,
    })).toMatchObject({ status: 'estimated', waitTimeMinutes: 30 });
  });

  it('fails the baseline gate when rows are missing or paid', () => {
    const report = assessWebcamWaitBaseline([
      { feedKey: 'feed-a', provider: 'tomtom', congestionScore: 0.2, vehicleCount: 2, providerWaitMinutes: 5, observedAt: '2026-10-15T06:00:00.000Z', incrementalPaidRequests: 1 },
    ]);
    expect(report.ready).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining([
      'requires at least 3 distinct feed keys',
      'requires at least 3 valid webcam/provider pairs',
      'pair coverage 0.000 is below 0.8',
      'baseline collection must add zero paid provider requests',
    ]));
  });

  it('rejects null and non-numeric webcam measurements before validation', () => {
    const make = (feedKey: string, extra: Record<string, unknown> = {}) => ({
      feedKey,
      provider: 'tomtom',
      congestionScore: 0,
      vehicleCount: 0,
      providerWaitMinutes: 0,
      candidateWaitMinutes: 0,
      observedAt: '2026-10-15T06:00:00.000Z',
      incrementalPaidRequests: 0,
      ...extra,
    });

    expect(assessWebcamWaitBaseline(
      ['feed-a', 'feed-b', 'feed-c'].map((feedKey) => make(feedKey, { candidateWaitMinutes: null })),
    ).ready).toBe(false);
    expect(assessWebcamWaitBaseline(
      ['feed-a', 'feed-b', 'feed-c'].map((feedKey) => make(feedKey, { vehicleCount: '' })),
    ).ready).toBe(false);
    expect(estimateWebcamWait(0, {
      validated: true,
      feedCount: 3,
      coverage: 0.8,
      maeMinutes: null,
      maxAbsoluteErrorMinutes: null,
      incrementalPaidRequests: 0,
      intercept: null,
      slope: null,
    }).status).toBe('unknown');
  });

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
    }).limits.map((limit) => limit.budget)).toEqual([1_000, HERE_MONTHLY_FREE_TIER_BUDGET]);
    for (const operation of ['traffic-situations', 'traffic-lights', 'traffic-counters']) {
      expect(providerQuotaDefinition('opentransportdata', operation, {
        OPENTRANSPORTDATA_QUOTA: '999999',
      })).toMatchObject({
        limits: [{ budget: 260_000, period: 'six-month' }],
        rateLimit: { maxPerMinute: 5, minIntervalMs: 12_500 },
      });
    }
    expect(providerQuotaDefinition('stadia').unitCost).toBe(20);
    expect(providerQuotaDefinition('graphhopper').rateLimit).toEqual({
      maxPerMinute: 20,
      minIntervalMs: 3_000,
    });
    expect(TRAFFIC_PROVIDER_SPECS.graphhopper).toMatchObject({ batchSize: 1, batchDelayMs: 0 });
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
    for (const storedCount of [undefined, null, '']) {
      expect(computeProviderBudgetDecision({
        storedPeriod: '2026-09-15',
        storedCount,
        period: '2026-09-15',
        callsThisRun: 1,
        budget: 2000,
      })).toMatchObject({ allowed: false });
    }
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
