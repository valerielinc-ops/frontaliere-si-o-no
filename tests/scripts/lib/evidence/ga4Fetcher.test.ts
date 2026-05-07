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
