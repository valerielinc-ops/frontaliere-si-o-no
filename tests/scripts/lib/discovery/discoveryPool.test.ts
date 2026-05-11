// tests/scripts/lib/discovery/discoveryPool.test.ts
//
// Spec § 6.10 acceptance — discovery pool returns valid candidates from
// at least 2 of 3 sources, dedupes against proven headlines, scores via
// source-specific multipliers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDiscoveryPool,
  dedupAgainstProven,
  scoreCandidates,
  fetchAll,
} from '../../../../scripts/lib/discovery/discoveryPool.mjs';

const evidence = {
  windowDays: 90,
  clusterStats: {
    fiscale: { p50: 200, p10: 50, p90: 800, n: 30 },
    generic: { p50: 50, p10: 5, p90: 200, n: 100 },
  },
  gsc: {
    queries: {
      'permesso g rinnovo': { imp: 1000, ctr: 0.05, pos: 4, clicks: 50 },
    },
    orphanQueries: [
      {
        query: 'tassazione frontalieri ticino',
        imp: 800,
        pos: 14,
        ctr: 0.005,
        topLandingPage: '/articoli-frontaliere/foo',
      },
    ],
  },
};

beforeEach(() => {
  delete process.env.DISABLE_DISCOVERY_ORPHAN;
  delete process.env.DISABLE_DISCOVERY_SUGGEST;
  delete process.env.DISABLE_DISCOVERY_NEWS;
});

afterEach(() => {
  delete process.env.DISABLE_DISCOVERY_ORPHAN;
  delete process.env.DISABLE_DISCOVERY_SUGGEST;
  delete process.env.DISABLE_DISCOVERY_NEWS;
});

const stubSuggest = async () => [
  { headline: 'tasse svizzera frontalieri 2026', url: null, source: 'suggest' as const, meta: { seed: 'tasse svizzera', rank: 0, normalizedKeyword: 'tasse svizzera frontalieri 2026' } },
  { headline: 'permesso b cantone ticino', url: null, source: 'suggest' as const, meta: { seed: 'permesso B', rank: 0, normalizedKeyword: 'permesso b cantone ticino' } },
];

const stubNews = async () => [
  {
    headline: 'frontalieri ticino',
    url: 'https://example.com/a',
    source: 'news' as const,
    meta: { ageHours: 2, sourceUrl: 'https://example.com/a', sourceName: 'tio.ch', pubDate: null, seed: 'frontalieri' },
  },
];

describe('fetchAll', () => {
  it('aggregates candidates from all 3 sources', async () => {
    const out = await fetchAll(evidence, { suggestFn: stubSuggest, newsFn: stubNews });
    expect(out.candidates.length).toBe(4);
    expect(out.perSource.orphan).toBe(1);
    expect(out.perSource.suggest).toBe(2);
    expect(out.perSource.news).toBe(1);
  });

  it('honors DISABLE_DISCOVERY_ORPHAN env flag', async () => {
    process.env.DISABLE_DISCOVERY_ORPHAN = '1';
    const out = await fetchAll(evidence, { suggestFn: stubSuggest, newsFn: stubNews });
    expect(out.perSource.orphan).toBe(0);
    expect(out.perSource.suggest).toBe(2);
    expect(out.perSource.news).toBe(1);
  });

  it('survives a failing source (returns what others produced)', async () => {
    const failingSuggest = async () => {
      throw new Error('boom');
    };
    const out = await fetchAll(evidence, { suggestFn: failingSuggest, newsFn: stubNews });
    expect(out.perSource.suggest).toBe(0);
    // orphan + news still populate.
    expect(out.candidates.length).toBeGreaterThan(0);
  });
});

describe('dedupAgainstProven', () => {
  it('keeps candidates that don\'t overlap with proven headlines', () => {
    const candidates = [
      { headline: 'permesso b cantone ticino', source: 'suggest' as const, url: null, meta: {} },
      { headline: 'tasse svizzera 2026', source: 'suggest' as const, url: null, meta: {} },
    ];
    const proven = ['mercato lavoro lugano disoccupazione'];
    const out = dedupAgainstProven(candidates, proven);
    expect(out).toHaveLength(2);
  });

  it('drops candidates similar to a proven headline (Jaccard >= 0.7)', () => {
    const candidates = [
      { headline: 'frontaliere ticino', source: 'news' as const, url: null, meta: {} },
      { headline: 'permesso b cantone ticino', source: 'suggest' as const, url: null, meta: {} },
    ];
    const proven = ['frontalieri in ticino'];
    const out = dedupAgainstProven(candidates, proven);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe('permesso b cantone ticino');
  });

  it('returns the input unchanged when proven list is empty', () => {
    const candidates = [{ headline: 'x', source: 'news' as const, url: null, meta: {} }];
    expect(dedupAgainstProven(candidates, [])).toEqual(candidates);
  });
});

describe('scoreCandidates', () => {
  it('attaches a score breakdown and sorts desc by finalScore', () => {
    const candidates = [
      // Suggest needs a domain anchor (post-Palermo regression hardening) —
      // see scripts/lib/discovery/domainAnchor.mjs.
      { headline: 'topic A frontalieri', source: 'suggest' as const, url: null, meta: {} },
      { headline: 'tassazione frontalieri ticino', source: 'orphan' as const, url: null, meta: { imp: 9000, pos: 14, ctr: 0.005 } },
    ];
    const scored = scoreCandidates(candidates, evidence);
    expect(scored).toHaveLength(2);
    expect(scored[0]._scoreBreakdown).toBeDefined();
    expect(scored[0]._discoveryScore).toBeGreaterThanOrEqual(scored[1]._discoveryScore);
  });

  it('returns [] when input is empty', () => {
    expect(scoreCandidates([], evidence)).toEqual([]);
  });
});

describe('buildDiscoveryPool', () => {
  it('end-to-end: 3 sources → dedup vs proven → score → sorted', async () => {
    const proven = ['frontalieri in ticino'];
    const out = await buildDiscoveryPool(evidence, {
      suggestFn: stubSuggest,
      newsFn: stubNews,
      provenHeadlines: proven,
    });
    // News candidate ('frontalieri ticino') is a near-dup of proven.
    const headlines = out.candidates.map((c) => c.headline);
    expect(headlines).not.toContain('frontalieri ticino');
    expect(out.candidates.length).toBeGreaterThanOrEqual(2);
    // perSource counts the PRE-dedup totals; postDedupCount reflects what survived.
    expect(out.perSource.news).toBe(1);
    expect(out.postDedupCount).toBe(out.candidates.length);
    // Sort order desc.
    for (let i = 1; i < out.candidates.length; i += 1) {
      expect(out.candidates[i - 1]._discoveryScore).toBeGreaterThanOrEqual(out.candidates[i]._discoveryScore);
    }
  });

  it('§ 6.10 acceptance — at least 2 of 3 sources produce candidates', async () => {
    const out = await buildDiscoveryPool(evidence, {
      suggestFn: stubSuggest,
      newsFn: stubNews,
    });
    let nonEmpty = 0;
    if (out.perSource.orphan > 0) nonEmpty += 1;
    if (out.perSource.suggest > 0) nonEmpty += 1;
    if (out.perSource.news > 0) nonEmpty += 1;
    expect(nonEmpty).toBeGreaterThanOrEqual(2);
  });
});
