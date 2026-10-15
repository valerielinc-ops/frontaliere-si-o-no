// tests/scripts/lib/alerts/detectors/pipeline.test.ts
//
// Spec § 8 — Category B detectors (B.1-B.6).

import { describe, expect, it } from 'vitest';

import { detectPipeline } from '../../../../../scripts/lib/alerts/detectors/pipeline.mjs';

const NOW = Date.parse('2026-05-08T00:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const config = {
  evidence_stale_max_hours: 36,
  cluster_stats_min_n: 10,
};

function makeArticle(overrides: Record<string, unknown> = {}) {
  return { slug: 'art', publishedAt: new Date(NOW - DAY).toISOString(), cluster: 'generic', ...overrides };
}

describe('B.1 evidence-index freshness', () => {
  it('fires P0 evidence-missing when file absent', () => {
    const out = detectPipeline({
      evidence: {},
      articles: [],
      config,
      now: NOW,
      readMtime: () => null,
    });
    const alert = out.find((a: any) => a.id === 'B.1.evidence-missing');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P0');
  });

  it('fires P0 evidence-stale when mtime older than threshold', () => {
    const out = detectPipeline({
      evidence: {},
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW - 50 * HOUR,
    });
    const alert = out.find((a: any) => a.id === 'B.1.evidence-stale');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P0');
  });

  it('does not fire when mtime fresh', () => {
    const out = detectPipeline({
      evidence: {},
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW - 1 * HOUR,
    });
    expect(out.find((a: any) => a.id === 'B.1.evidence-stale')).toBeUndefined();
    expect(out.find((a: any) => a.id === 'B.1.evidence-missing')).toBeUndefined();
  });
});

describe('B.2 GSC fetch failure', () => {
  it('fires when evidence.gsc.error is set', () => {
    const out = detectPipeline({
      evidence: { gsc: { error: 'quota exceeded' } },
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW,
    });
    expect(out.find((a: any) => a.id === 'B.2.gsc-fetch-failure')).toBeDefined();
  });
});

describe('B.3 GA4 fetch failure', () => {
  it('fires when evidence.ga4.error is set', () => {
    const out = detectPipeline({
      evidence: { ga4: { error: 'access denied' } },
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW,
    });
    expect(out.find((a: any) => a.id === 'B.3.ga4-fetch-failure')).toBeDefined();
  });
});

describe('B.4 PostHog fetch failure', () => {
  it('fires P2 when evidence.posthog.error is set', () => {
    const out = detectPipeline({
      evidence: { posthog: { error: 'auth fail' } },
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW,
    });
    const alert = out.find((a: any) => a.id === 'B.4.posthog-fetch-failure');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P2');
  });
});

describe('B.5 cluster-stats degenerate', () => {
  it('fires when a cluster used in last 7d publications has n < threshold', () => {
    const out = detectPipeline({
      evidence: {
        clusterStats: { fiscale: { p10: 1, p50: 5, p90: 10, n: 3 } },
      },
      articles: [makeArticle({ cluster: 'fiscale' }), makeArticle({ cluster: 'fiscale', slug: 'b' })],
      config,
      now: NOW,
      readMtime: () => NOW,
    });
    expect(out.find((a: any) => a.id === 'B.5.cluster-stats-degenerate')).toBeDefined();
  });

  it('does not fire when n is healthy', () => {
    const out = detectPipeline({
      evidence: {
        clusterStats: { fiscale: { p10: 10, p50: 50, p90: 200, n: 30 } },
      },
      articles: [makeArticle({ cluster: 'fiscale' })],
      config,
      now: NOW,
      readMtime: () => NOW,
    });
    expect(out.find((a: any) => a.id === 'B.5.cluster-stats-degenerate')).toBeUndefined();
  });
});

describe('B.6 embedding store outdated', () => {
  it('fires when blog-meta count exceeds embeddings count by >50', () => {
    const out = detectPipeline({
      evidence: {},
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW,
      countBlogArticles: () => 1200,
      embeddingsCount: () => 1100,
    });
    expect(out.find((a: any) => a.id === 'B.6.embedding-store-outdated')).toBeDefined();
  });

  it('does not fire when gap is small', () => {
    const out = detectPipeline({
      evidence: {},
      articles: [],
      config,
      now: NOW,
      readMtime: () => NOW,
      countBlogArticles: () => 1100,
      embeddingsCount: () => 1090,
    });
    expect(out.find((a: any) => a.id === 'B.6.embedding-store-outdated')).toBeUndefined();
  });
});
