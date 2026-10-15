// tests/scripts/lib/discovery/sources/googleTrendsSource.test.ts

import { describe, expect, it } from 'vitest';

import { fetchTrendsDiscoveryCandidates } from '../../../../../scripts/lib/discovery/sources/googleTrendsSource.mjs';

describe('fetchTrendsDiscoveryCandidates', () => {
  const stubTrendsFn = (candidates: any[]) => async () => ({
    ok: candidates.length > 0,
    candidates,
  });

  it('maps anchored Trends payloads to discovery candidates with source=trends', async () => {
    const out = await fetchTrendsDiscoveryCandidates({}, {
      trendsFn: stubTrendsFn([
        {
          keyword: 'telelavoro frontalieri svizzera italia',
          demandSignals: {
            googleTrendsScore: 2000,
            googleTrendsGeo: 'IT',
            googleTrendsSeed: 'telelavoro frontalieri',
            googleTrendsViaRss: true,
          },
        },
      ]),
    });

    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('trends');
    expect(out[0].headline).toBe('telelavoro frontalieri svizzera italia');
    expect(out[0].meta.rawScore).toBe(2000);
    expect(out[0].meta.score).toBeGreaterThan(0);
    expect(out[0].meta.score).toBeLessThanOrEqual(100);
    expect(out[0].meta.geo).toBe('IT');
    expect(out[0].meta.viaRss).toBe(true);
  });

  it('drops unanchored, duplicate, and already-proven trends', async () => {
    const evidence = {
      gsc: {
        queries: {
          'lamal frontalieri ticino': { imp: 100, clicks: 10, ctr: 0.1, pos: 3 },
        },
      },
    };
    const out = await fetchTrendsDiscoveryCandidates(evidence, {
      trendsFn: stubTrendsFn([
        { keyword: 'bonus benzina italia', demandSignals: { googleTrendsScore: 100 } },
        { keyword: 'LAMal frontalieri Ticino', demandSignals: { googleTrendsScore: 100 } },
        { keyword: 'permesso g frontalieri ticino', demandSignals: { googleTrendsScore: 100 } },
        { keyword: 'Permesso G frontalieri Ticino', demandSignals: { googleTrendsScore: 80 } },
      ]),
    });

    expect(out.map((c) => c.headline)).toEqual(['permesso g frontalieri ticino']);
  });

  it('returns [] when the Trends fetcher throws', async () => {
    const out = await fetchTrendsDiscoveryCandidates({}, {
      trendsFn: async () => {
        throw new Error('network down');
      },
    });
    expect(out).toEqual([]);
  });
});
