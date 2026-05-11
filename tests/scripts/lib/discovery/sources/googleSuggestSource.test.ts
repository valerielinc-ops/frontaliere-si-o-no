// tests/scripts/lib/discovery/sources/googleSuggestSource.test.ts

import { describe, expect, it } from 'vitest';

import {
  fetchSuggestDiscoveryCandidates,
  pickClusterSeeds,
} from '../../../../../scripts/lib/discovery/sources/googleSuggestSource.mjs';

describe('pickClusterSeeds', () => {
  it('returns [] when clusterStats is missing', () => {
    expect(pickClusterSeeds(null as any)).toEqual([]);
    expect(pickClusterSeeds({})).toEqual([]);
  });

  it('skips generic, sorts by p50 desc, anchors each seed with " frontalieri"', () => {
    const stats = {
      fiscale: { p50: 200, p10: 50, p90: 800, n: 30 },
      salute: { p50: 120, p10: 30, p90: 500, n: 20 },
      generic: { p50: 999, p10: 5, p90: 200, n: 100 },
      lavoro: { p50: 80, p10: 20, p90: 300, n: 10 },
    };
    const seeds = pickClusterSeeds(stats);
    // Anchored to prevent generic-Italian completions like "mobilita
    // palermo" — see scripts/lib/discovery/domainAnchor.mjs.
    expect(seeds).toEqual([
      'fiscale frontalieri',
      'salute frontalieri',
      'lavoro frontalieri',
    ]);
  });

  it('drops clusters without a numeric p50', () => {
    const stats = {
      fiscale: { p50: 200 },
      broken: { p10: 10 },
    };
    expect(pickClusterSeeds(stats)).toEqual(['fiscale frontalieri']);
  });
});

describe('fetchSuggestDiscoveryCandidates', () => {
  const stubSuggestFn = (candidates: any[]) => async (_opts: any) => ({
    ok: candidates.length > 0,
    perSeed: {},
    candidates,
  });

  it('returns [] when fetcher yields no candidates', async () => {
    const out = await fetchSuggestDiscoveryCandidates({}, { suggestFn: stubSuggestFn([]) });
    expect(out).toEqual([]);
  });

  it('maps suggest payload to discovery candidates with source=suggest', async () => {
    const candidates = [
      {
        keyword: 'tasse svizzera frontalieri 2026',
        normalizedKeyword: 'tasse svizzera frontalieri 2026',
        demandSignals: { googleSuggestSeed: 'tasse svizzera', googleSuggestRank: 0 },
      },
      {
        keyword: 'permesso g rinnovo',
        normalizedKeyword: 'permesso g rinnovo',
        demandSignals: { googleSuggestSeed: 'permesso G', googleSuggestRank: 1 },
      },
    ];
    const out = await fetchSuggestDiscoveryCandidates({}, { suggestFn: stubSuggestFn(candidates) });
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('suggest');
    expect(out[0].headline).toBe('tasse svizzera frontalieri 2026');
    expect(out[0].meta.seed).toBe('tasse svizzera');
    expect(out[0].meta.rank).toBe(0);
  });

  it('drops candidates that are already in evidence.gsc.queries (proven)', async () => {
    const evidence = {
      gsc: {
        queries: {
          'permesso g rinnovo': { imp: 1000, ctr: 0.05, pos: 4, clicks: 50 },
        },
      },
    };
    const candidates = [
      { keyword: 'tasse svizzera frontalieri', normalizedKeyword: 'tasse svizzera frontalieri' },
      { keyword: 'Permesso G Rinnovo', normalizedKeyword: 'permesso g rinnovo' },
    ];
    const out = await fetchSuggestDiscoveryCandidates(evidence, { suggestFn: stubSuggestFn(candidates) });
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe('tasse svizzera frontalieri');
  });

  it('dedupes within the suggest payload by lowercased headline', async () => {
    const candidates = [
      { keyword: 'tasse svizzera', normalizedKeyword: 'tasse svizzera' },
      { keyword: 'Tasse Svizzera', normalizedKeyword: 'tasse svizzera' },
    ];
    const out = await fetchSuggestDiscoveryCandidates({}, { suggestFn: stubSuggestFn(candidates) });
    expect(out).toHaveLength(1);
  });

  it('passes anchored cluster-derived seeds to the underlying fetcher', async () => {
    let captured: any = null;
    const captureFn = async (opts: any) => {
      captured = opts;
      return { ok: true, perSeed: {}, candidates: [] };
    };
    const evidence = {
      clusterStats: {
        fiscale: { p50: 200 },
        salute: { p50: 100 },
        generic: { p50: 999 },
      },
    };
    await fetchSuggestDiscoveryCandidates(evidence, { suggestFn: captureFn });
    expect(captured.seeds).toEqual(['fiscale frontalieri', 'salute frontalieri']);
  });

  // Regression — 2026-05-11 `mobilita-palermo-frontalieri-ticino`.
  // Even when Google Suggest returns generic-Italian completions for
  // an anchored seed, the source MUST drop them via hasDomainAnchor.
  it('drops candidates whose headline lacks any Ticino/frontalieri anchor', async () => {
    const candidates = [
      { keyword: 'mobilita palermo', normalizedKeyword: 'mobilita palermo' },
      { keyword: 'salute roma', normalizedKeyword: 'salute roma' },
      { keyword: 'pensioni napoli centro', normalizedKeyword: 'pensioni napoli centro' },
      { keyword: 'mobilita lugano', normalizedKeyword: 'mobilita lugano' },
      { keyword: 'fiscale ticino', normalizedKeyword: 'fiscale ticino' },
    ];
    const out = await fetchSuggestDiscoveryCandidates({}, { suggestFn: stubSuggestFn(candidates) });
    expect(out.map((c) => c.headline)).toEqual(['mobilita lugano', 'fiscale ticino']);
  });

  it('returns [] when fetcher throws', async () => {
    const throwingFn = async () => {
      throw new Error('network down');
    };
    const out = await fetchSuggestDiscoveryCandidates({}, { suggestFn: throwingFn });
    expect(out).toEqual([]);
  });
});
