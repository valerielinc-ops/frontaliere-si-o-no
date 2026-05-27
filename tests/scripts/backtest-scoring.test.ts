// tests/scripts/backtest-scoring.test.ts
//
// Phase 2 — backtest harness smoke test on a small in-memory fixture.
// Does NOT run the full live backtest; that's done by the orchestrator
// against the real evidence index. Spec § 5.10.

import { describe, expect, it } from 'vitest';

import {
  synthesizeHistoricalHeadlines,
  lookupActualSessions,
  runBacktest,
} from '../../scripts/backtest-scoring.mjs';

describe('synthesizeHistoricalHeadlines', () => {
  it('returns [] when articles list is missing', () => {
    expect(synthesizeHistoricalHeadlines({}, 60)).toEqual([]);
    expect(synthesizeHistoricalHeadlines(null, 60)).toEqual([]);
  });

  it('extracts headline + slug + sessions', () => {
    const perf = {
      articles: [
        { title: 'Frontalieri Ticino calo 2026', slug: 'frontalieri-calo', publishedAt: new Date().toISOString(), metrics: { sessions: 320 } },
      ],
    };
    const out = synthesizeHistoricalHeadlines(perf, 60);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe('Frontalieri Ticino calo 2026');
    expect(out[0].slug).toBe('frontalieri-calo');
    expect(out[0].actualSessions).toBe(320);
  });

  it('drops articles older than the window', () => {
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const perf = {
      articles: [
        { title: 'Old article', slug: 'old', publishedAt: old, metrics: { sessions: 100 } },
        { title: 'Fresh article', slug: 'fresh', publishedAt: new Date().toISOString(), metrics: { sessions: 50 } },
      ],
    };
    const out = synthesizeHistoricalHeadlines(perf, 60);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('fresh');
  });

  it('falls back to top-level sessions when metrics.sessions is absent', () => {
    const perf = {
      articles: [
        { title: 'X', slug: 'x', publishedAt: new Date().toISOString(), sessions: 42 },
      ],
    };
    const out = synthesizeHistoricalHeadlines(perf, 60);
    expect(out[0].actualSessions).toBe(42);
  });
});

describe('lookupActualSessions', () => {
  it('returns null on missing slug', () => {
    expect(lookupActualSessions(null, { ga4: { pages: {} } })).toBeNull();
  });

  it('finds slug under /articoli-frontaliere/<slug>/', () => {
    const evidence = {
      ga4: { pages: { '/articoli-frontaliere/foo/': { sessions: 222 } } },
    };
    expect(lookupActualSessions('foo', evidence)).toBe(222);
  });

  it('returns null when slug not in evidence', () => {
    const evidence = { ga4: { pages: { '/articoli-frontaliere/bar/': { sessions: 1 } } } };
    expect(lookupActualSessions('foo', evidence)).toBeNull();
  });
});

describe('runBacktest (smoke)', () => {
  const evidence = {
    windowDays: 90,
    gsc: { queries: {} },
    ga4: {
      pages: {
        '/articoli-frontaliere/frontalieri-calo/': { sessions: 320 },
        '/articoli-frontaliere/old/': { sessions: 50 },
      },
    },
    clusterStats: {
      fiscale: { p10: 50, p50: 200, p90: 800 },
      generic: { p10: 5, p50: 50, p90: 200 },
    },
  };

  it('produces a report with stageCounts and averages', async () => {
    const historical = [
      { headline: 'Frontalieri Ticino calo 2026', slug: 'frontalieri-calo', publishedAt: null, actualSessions: 320 },
      { headline: 'Bayern Champions League', slug: 'old', publishedAt: null, actualSessions: 50 },
    ];
    const report = await runBacktest(historical, evidence, { noEmbedding: true });
    expect(report.scoredCount).toBeGreaterThan(0);
    expect(typeof report.stageCounts).toBe('object');
    // All stages should be 'cluster' since no GSC + no embedding.
    expect(report.stageCounts.cluster).toBeGreaterThan(0);
    expect(typeof report.runAt).toBe('string');
  });

  it('handles empty historical input gracefully', async () => {
    const report = await runBacktest([], evidence, { noEmbedding: true });
    expect(report.scoredCount).toBe(0);
  });

  it('respects the --max cap', async () => {
    const historical = Array.from({ length: 10 }, (_, i) => ({
      headline: `Tasse svizzera ${i}`,
      slug: null,
      publishedAt: null,
      actualSessions: null,
    }));
    const report = await runBacktest(historical, evidence, { noEmbedding: true, max: 3 });
    expect(report.scoredCount).toBe(3);
  });
});
