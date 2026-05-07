import { describe, expect, it, vi } from 'vitest';

import * as gscMod from '../../../../scripts/lib/evidence/gscFetcher.mjs';

const { fetchGscQueries } = gscMod as any;

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
