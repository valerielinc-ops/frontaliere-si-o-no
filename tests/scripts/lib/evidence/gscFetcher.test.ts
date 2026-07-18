import { describe, expect, it, vi } from 'vitest';

import * as gscMod from '../../../../scripts/lib/evidence/gscFetcher.mjs';

const { fetchGscQueries, fetchGscPageImpressions } = gscMod as any;

function jsonRes(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('fetchGscQueries', () => {
  it('aggregates queries, attaches topLandingPage, identifies orphans', async () => {
    // Pass 1 (dimensions=['query']) and Pass 2 (dimensions=['query','page']).
    const queryRows = {
      rows: [
        { keys: ['Frontaliere Stipendio'], impressions: 500, clicks: 30, position: 4.2, ctr: 0.06 },
        { keys: ['orphan query'], impressions: 200, clicks: 1, position: 15.5, ctr: 0.005 },
        { keys: ['noise'], impressions: 2, clicks: 0, position: 30, ctr: 0 }, // below GSC_MIN_IMP
      ],
    };
    const queryPageRows = {
      rows: [
        { keys: ['Frontaliere Stipendio', 'https://frontaliereticino.ch/articoli-frontaliere/stipendio/'], impressions: 400 },
        { keys: ['Frontaliere Stipendio', 'https://frontaliereticino.ch/calcola-stipendio/'], impressions: 100 },
        { keys: ['orphan query', '/articoli-frontaliere/foo/'], impressions: 200 },
      ],
    };

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return jsonRes(queryRows);
      if (call === 2) return jsonRes(queryPageRows);
      return jsonRes({ rows: [] });
    });

    const result = await fetchGscQueries({
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });

    expect(result.error).toBeUndefined();
    expect(result.queries['frontaliere stipendio']).toBeDefined();
    expect(result.queries['frontaliere stipendio'].imp).toBe(500);
    expect(result.queries['frontaliere stipendio'].topLandingPage).toBe('/articoli-frontaliere/stipendio/');
    expect(result.queries['noise']).toBeUndefined();
    expect(result.orphanQueries).toHaveLength(1);
    expect(result.orphanQueries[0].query).toBe('orphan query');
  });

  it('Pass 3: aggregates the full page-level impression set (Buco G)', async () => {
    // Pass 1 (query), Pass 2 (query+page), Pass 3 (page) — the new pass
    // returns every impressed URL keyed by path → impressions.
    const queryRows = {
      rows: [{ keys: ['ticino lavoro'], impressions: 80, clicks: 5, position: 6, ctr: 0.06 }],
    };
    const queryPageRows = {
      rows: [{ keys: ['ticino lavoro', '/cerca-lavoro-ticino/'], impressions: 80 }],
    };
    const pageRows = {
      rows: [
        { keys: ['https://frontaliereticino.ch/cerca-lavoro-ticino/'], impressions: 80 },
        { keys: ['/cerca-lavoro-ticino/ricerca-infermiere/'], impressions: 3 },
        { keys: ['/cerca-lavoro-ticino/zero-imp/'], impressions: 0 }, // dropped (<1)
      ],
    };

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return jsonRes(queryRows);
      if (call === 2) return jsonRes(queryPageRows);
      if (call === 3) return jsonRes(pageRows);
      return jsonRes({ rows: [] });
    });

    const result = await fetchGscQueries({
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });

    expect(result.error).toBeUndefined();
    expect(result.pages).toBeDefined();
    // absolute URL normalized to path
    expect(result.pages['/cerca-lavoro-ticino/']).toBe(80);
    // long-tail page that never owns a query is still captured
    expect(result.pages['/cerca-lavoro-ticino/ricerca-infermiere/']).toBe(3);
    // zero-impression rows are dropped
    expect(result.pages['/cerca-lavoro-ticino/zero-imp/']).toBeUndefined();
  });

  it('isolates a Pass 3 failure: preserves Pass 1+2 results and surfaces the error', async () => {
    // Pass 1 + Pass 2 succeed; Pass 3 fails on both sc-domain and url-prefix
    // (gscQuery retries the fallback property before throwing). The page set
    // is lost, but queries/orphans from the earlier passes must survive
    // instead of being zeroed wholesale (over-thinning regression guard).
    const queryRows = {
      rows: [{ keys: ['ticino lavoro'], impressions: 80, clicks: 5, position: 6, ctr: 0.06 }],
    };
    const queryPageRows = {
      rows: [{ keys: ['ticino lavoro', '/cerca-lavoro-ticino/'], impressions: 80 }],
    };
    const fail = jsonRes('server error', { ok: false, status: 500 });

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return jsonRes(queryRows);
      if (call === 2) return jsonRes(queryPageRows);
      return fail; // Pass 3: sc-domain + url-prefix fallback both 500
    });

    const result = await fetchGscQueries({
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });

    expect(result.queries['ticino lavoro']).toBeDefined();
    expect(result.queries['ticino lavoro'].imp).toBe(80);
    expect(result.queries['ticino lavoro'].topLandingPage).toBe('/cerca-lavoro-ticino/');
    expect(result.pages).toEqual({});
    expect(result.error).toContain('pass3');
    expect(result.error).toContain('500');
  });

  it('returns error key when token mint fails (does not throw)', async () => {
    const result = await fetchGscQueries({
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl: vi.fn(),
      getTokenImpl: async () => {
        throw new Error('no creds');
      },
    });
    expect(result.error).toContain('no creds');
    expect(result.queries).toEqual({});
    expect(result.orphanQueries).toEqual([]);
  });

  it('returns error key when API returns 5xx for both sc-domain and url-prefix (does not throw)', async () => {
    // gscFetcher retries the URL-prefix property when sc-domain fails, so we
    // need both calls to fail before the helper surfaces an error.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'server error',
    }));
    const result = await fetchGscQueries({
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });
    expect(result.error).toContain('500');
    expect(result.queries).toEqual({});
  });
});

// issue #4407: scripts/fetch-thin-page-promotions.mjs reuses this lighter
// single-pass fetcher (page dimension only) instead of paying for
// fetchGscQueries' three passes every hour.
describe('fetchGscPageImpressions', () => {
  it('aggregates page-level impressions, applying the minImpressions floor', async () => {
    const pageRows = {
      rows: [
        { keys: ['https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-infermiere/'], impressions: 12 },
        { keys: ['/cerca-lavoro-ticino/ricerca-idraulico/'], impressions: 2 }, // below floor
        { keys: ['/cerca-lavoro-ticino/zero-imp/'], impressions: 0 }, // below floor
      ],
    };
    const fetchImpl = vi.fn(async () => jsonRes(pageRows));

    const result = await fetchGscPageImpressions({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      minImpressions: 5,
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });

    expect(result.error).toBeUndefined();
    // absolute URL normalized to path
    expect(result.pages['/cerca-lavoro-ticino/ricerca-infermiere/']).toBe(12);
    expect(result.pages['/cerca-lavoro-ticino/ricerca-idraulico/']).toBeUndefined();
    expect(result.pages['/cerca-lavoro-ticino/zero-imp/']).toBeUndefined();
    // single page-dimension pass — no query / query+page calls.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('defaults minImpressions to 1 (matches fetchGscQueries Pass 3 threshold)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ rows: [{ keys: ['/foo/'], impressions: 1 }] }),
    );
    const result = await fetchGscPageImpressions({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });
    expect(result.pages['/foo/']).toBe(1);
  });

  it('returns error key when token mint fails (does not throw)', async () => {
    const result = await fetchGscPageImpressions({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      fetchImpl: vi.fn(),
      getTokenImpl: async () => {
        throw new Error('no creds');
      },
    });
    expect(result.error).toContain('no creds');
    expect(result.pages).toEqual({});
  });

  it('returns error key when API returns 5xx for both sc-domain and url-prefix (does not throw)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'server error',
    }));
    const result = await fetchGscPageImpressions({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });
    expect(result.error).toContain('500');
    expect(result.pages).toEqual({});
  });
});
