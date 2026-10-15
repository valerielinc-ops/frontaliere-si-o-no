import { describe, it, expect } from 'vitest';
import { fetchGscByPage } from '../scripts/lib/perf-sources/gsc.mjs';

// Regression guard for issue #5964: the Search Console API ANDs multiple
// `contains` filters on the same dimension no matter how they're grouped in
// `dimensionFilterGroups` — there is no request shape that ORs them. A
// family with 2+ locale-slug `pathAliases` (see scripts/lib/seo-ctr-curve.mjs)
// must therefore issue one request PER alias and merge results client-side;
// a single combined-filter request always came back empty.
describe('fetchGscByPage — locale-alias union (issue #5964)', () => {
  const getTokenImpl = async () => 'fake-token';

  it('merges results from multiple pathContains aliases into one perPath map', async () => {
    const calls = [];
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const expression = body.dimensionFilterGroups?.[0]?.filters?.[0]?.expression;
      calls.push(expression);
      const byExpression = {
        '/cerca-lavoro-svizzera/': [
          { keys: ['https://frontaliereticino.ch/cerca-lavoro-svizzera/annuncio-it/'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
        ],
        '/find-jobs-switzerland/': [
          { keys: ['https://frontaliereticino.ch/find-jobs-switzerland/annuncio-en/'], clicks: 5, impressions: 50, ctr: 0.1, position: 6 },
        ],
      };
      return { ok: true, json: async () => ({ rows: byExpression[expression] || [] }) };
    };

    const { rows, perPath } = await fetchGscByPage({
      windowDays: 90,
      pathContains: ['/cerca-lavoro-svizzera/', '/find-jobs-switzerland/'],
      fetchImpl,
      getTokenImpl,
    });

    // One API call per alias, never a single combined-filter call.
    expect(calls).toEqual(['/cerca-lavoro-svizzera/', '/find-jobs-switzerland/']);
    // Union of both requests' pages, not empty (the AND bug returned zero rows).
    expect(rows).toBe(2);
    expect(perPath.size).toBe(2);
    expect(perPath.get('/cerca-lavoro-svizzera/annuncio-it/')).toEqual({ clicks: 10, impressions: 100, ctr: 0.1, position: 5 });
    expect(perPath.get('/find-jobs-switzerland/annuncio-en/')).toEqual({ clicks: 5, impressions: 50, ctr: 0.1, position: 6 });
  });

  it('never sends more than one filter expression per request', async () => {
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const groups = body.dimensionFilterGroups || [];
      const totalFilters = groups.reduce((sum, g) => sum + (g.filters?.length || 0), 0);
      expect(totalFilters, 'a single request must carry exactly one contains filter').toBe(1);
      return { ok: true, json: async () => ({ rows: [] }) };
    };

    await fetchGscByPage({
      windowDays: 90,
      pathContains: ['/a/', '/b/', '/c/'],
      fetchImpl,
      getTokenImpl,
    });
  });

  it('still works for a single string pathContains (no aliases)', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        rows: [{ keys: ['https://frontaliereticino.ch/articoli-frontaliere/un-post/'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }],
      }),
    });

    const { rows, perPath } = await fetchGscByPage({
      windowDays: 30,
      pathContains: '/articoli-frontaliere/',
      fetchImpl,
      getTokenImpl,
    });

    expect(rows).toBe(1);
    expect(perPath.get('/articoli-frontaliere/un-post/')).toBeTruthy();
  });
});
