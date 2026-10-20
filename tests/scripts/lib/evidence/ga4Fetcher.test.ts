import { describe, expect, it, vi } from 'vitest';

import * as ga4Mod from '../../../../scripts/lib/evidence/ga4Fetcher.mjs';

const { fetchGa4Pages } = ga4Mod as any;

function jsonRes(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('fetchGa4Pages', () => {
  it('returns per-page sessions, engageTime, attaches cluster from path', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        rows: [
          {
            dimensionValues: [{ value: '/articoli-frontaliere/stipendio-netto-2026/' }],
            metricValues: [{ value: '120' }, { value: '600' }, { value: '180' }],
          },
          {
            dimensionValues: [{ value: '/articoli-frontaliere/lamal-vs-cmi/' }],
            metricValues: [{ value: '40' }, { value: '120' }, { value: '60' }],
          },
          {
            // Below threshold (sessions < GA4_MIN_SESSIONS=3) — must be filtered.
            dimensionValues: [{ value: '/some/other/page' }],
            metricValues: [{ value: '1' }, { value: '5' }, { value: '2' }],
          },
        ],
      }),
    );

    const result = await fetchGa4Pages({
      propertyId: '123456789',
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });

    expect(result.error).toBeUndefined();
    expect(result.pages['/articoli-frontaliere/stipendio-netto-2026/']).toBeDefined();
    expect(result.pages['/articoli-frontaliere/stipendio-netto-2026/'].sessions).toBe(120);
    // engageTime = userEngagementDuration / sessions = 600 / 120 = 5
    expect(result.pages['/articoli-frontaliere/stipendio-netto-2026/'].engageTime).toBe(5);
    expect(result.pages['/some/other/page']).toBeUndefined();
    // Cluster classification works (stipend pattern → fiscale)
    expect(result.pages['/articoli-frontaliere/stipendio-netto-2026/'].cluster).toBe('fiscale');
  });

  it('returns clear error message on 403 (SA missing GA4 viewer role)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'permission denied',
    }));
    const result = await fetchGa4Pages({
      propertyId: '999',
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
      getTokenImpl: async () => 'fake-token',
    });
    expect(result.error).toContain('GA4 access denied');
    expect(result.pages).toEqual({});
  });

  it('returns error key when no propertyId set (does not throw)', async () => {
    const original = process.env.GA4_PROPERTY_ID;
    delete process.env.GA4_PROPERTY_ID;
    try {
      const result = await fetchGa4Pages({
        propertyId: '',
        startDate: '2026-02-01',
        endDate: '2026-05-01',
        fetchImpl: vi.fn(),
        getTokenImpl: async () => 'fake-token',
      });
      expect(result.error).toContain('GA4_PROPERTY_ID');
    } finally {
      if (original !== undefined) process.env.GA4_PROPERTY_ID = original;
    }
  });
});


it('preserves observed pages and marks the missing GA4 tail as incomplete', async () => {
  const result = await fetchGa4Pages({
    propertyId: '123', startDate: '2026-09-01', endDate: '2026-09-30',
    getTokenImpl: async () => 'test-token',
    fetchImpl: async () => jsonRes({ rowCount: 100001, rows: [{
      dimensionValues: [{ value: '/observed/' }],
      metricValues: [{ value: '12' }, { value: '60' }, { value: '20' }],
    }] }),
  });
  expect(result.pages['/observed/'].sessions).toBe(12);
  expect(result.coverage.complete).toBe(false);
  expect(result.error).toContain('absence is not zero traffic');
});

// Run 37196058978 (issue 11423): 138.894 pagePath in 28 giorni contro un
// runReport chiesto con limit 100000 e senza offset. La risposta era sempre
// troncata e seo-health-loop trattava GA4 come fonte assente a ogni run.
// Il fake rispetta offset/limit come l'API vera.
function pagedGa4(totalRows: number) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const offset = Number(body.offset ?? 0);
    const end = Math.min(totalRows, offset + Number(body.limit));
    const rows = [];
    for (let i = offset; i < end; i += 1) {
      rows.push({ dimensionValues: [{ value: `/p/${i}/` }], metricValues: [{ value: '5' }, { value: '50' }, { value: '9' }] });
    }
    return jsonRes({ rowCount: totalRows, rows });
  });
}

it('pagina runReport con offset fino a rowCount: 138894 righe non sono una fonte assente', async () => {
  const fetchImpl = pagedGa4(138_894);
  const result = await fetchGa4Pages({
    propertyId: '123', startDate: '2026-09-06', endDate: '2026-10-03',
    getTokenImpl: async () => 'test-token', fetchImpl,
  });
  expect(result.error).toBeUndefined();
  expect(result.coverage).toEqual({ complete: true, returnedRows: 138_894, reportedRows: 138_894 });
  expect(Object.keys(result.pages)).toHaveLength(result.coverage.reportedRows);
  const offsets = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).offset ?? 0);
  expect(offsets[0]).toBe(0);
  expect(offsets.length).toBeGreaterThan(1);
});
