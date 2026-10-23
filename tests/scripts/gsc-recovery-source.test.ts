import { describe, expect, it } from 'vitest';
import rowLimitFixture from '../fixtures/gsc-seo-recovery/api-row-limit.json';
import {
  fetchGscSearchAnalyticsRows,
  GSC_QUERY_ROW_LIMIT,
} from '../../scripts/lib/gsc-recovery-source.mjs';

describe('GSC recovery Search Analytics fetcher', () => {
  it('sends the per-request limit, not the multi-page total cap', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ rows: [{ keys: ['/fixture/'], clicks: 1, impressions: 2, position: 3 }] }),
      } as Response;
    };

    const result = await fetchGscSearchAnalyticsRows('offline-token', {
      startDate: '2026-10-12',
      endDate: '2026-10-18',
      dimensions: ['page'],
      dataState: 'final',
    }, { fetchImpl });

    expect(GSC_QUERY_ROW_LIMIT).toBe(rowLimitFixture.maxRowLimitPerRequest);
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].rowLimit).toBe(rowLimitFixture.maxRowLimitPerRequest);
    expect(Number(requestBodies[0].rowLimit)).toBeLessThanOrEqual(rowLimitFixture.maxRowLimitPerRequest);
    expect(requestBodies[0].startRow).toBe(0);
    expect(result).toMatchObject({ complete: true, returnedRows: rowLimitFixture.expectedRows });
  });
});
