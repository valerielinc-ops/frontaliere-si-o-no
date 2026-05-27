import { describe, expect, it } from 'vitest';

import * as csbMod from '../../../../scripts/lib/evidence/clusterStatsBuilder.mjs';

const { buildClusterStats } = csbMod as any;

describe('buildClusterStats', () => {
  // Reference "now" — Jan 1 2027 — so anything published in 2026 is ≥14d old.
  const now = Date.parse('2027-01-01T00:00:00Z');

  it('computes p10/p50/p90 per cluster for ramped articles', () => {
    const ga4Pages: Record<string, any> = {};
    // 5 fiscale articles with sessions [10, 20, 30, 40, 50]
    [10, 20, 30, 40, 50].forEach((s, i) => {
      ga4Pages[`/articoli-frontaliere/fiscale-${i}/`] = {
        sessions: s,
        publishedAt: '2026-01-01',
        cluster: 'fiscale',
      };
    });
    const stats = buildClusterStats(ga4Pages, { now });
    expect(stats.fiscale.n).toBe(5);
    expect(stats.fiscale.p50).toBe(30);
    expect(stats.fiscale.p10).toBe(10);
    expect(stats.fiscale.p90).toBe(50);
    // global aggregate is computed too
    expect(stats.global.n).toBe(5);
  });

  it('skips articles published <14 days ago (not yet ramped)', () => {
    // recent date — within 14d of `now`
    const recent = new Date(now - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const ga4Pages = {
      '/articoli-frontaliere/recent/': {
        sessions: 100,
        publishedAt: recent,
        cluster: 'fiscale',
      },
    };
    const stats = buildClusterStats(ga4Pages, { now });
    // Cluster should not have been recorded at all — the only article is too fresh.
    expect(stats.fiscale).toBeUndefined();
    expect(stats.global.n).toBe(0);
  });

  it('skips articles with missing publishedAt', () => {
    const ga4Pages = {
      '/articoli-frontaliere/foo/': { sessions: 80, publishedAt: null, cluster: 'fiscale' },
    };
    const stats = buildClusterStats(ga4Pages, { now });
    expect(stats.fiscale).toBeUndefined();
  });

  it('records n but no percentiles when sample < CLUSTER_MIN_N', () => {
    const ga4Pages: Record<string, any> = {};
    [10, 20, 30].forEach((s, i) => {
      ga4Pages[`/articoli-frontaliere/x-${i}/`] = {
        sessions: s,
        publishedAt: '2026-01-01',
        cluster: 'pratico',
      };
    });
    const stats = buildClusterStats(ga4Pages, { now });
    expect(stats.pratico.n).toBe(3);
    expect(stats.pratico.p50).toBe(0);
    expect(stats.pratico.p10).toBe(0);
    expect(stats.pratico.p90).toBe(0);
  });

  it('buckets undefined cluster as `generic`', () => {
    const ga4Pages: Record<string, any> = {};
    for (let i = 0; i < 5; i++) {
      ga4Pages[`/articoli-frontaliere/g-${i}/`] = {
        sessions: 100 + i,
        publishedAt: '2026-01-01',
        cluster: null,
      };
    }
    const stats = buildClusterStats(ga4Pages, { now });
    expect(stats.generic.n).toBe(5);
  });
});
