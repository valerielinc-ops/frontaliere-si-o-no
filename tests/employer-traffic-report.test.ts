import { describe, it, expect } from 'vitest';
import {
  aggregateGa4Rows,
  comparePostHogCompany,
  postHogBaseQuery,
  reportPayload,
  resolveGa4Employers,
} from '../scripts/employer-traffic-report.mjs';

const WINDOW = {
  from: '2026-06-10T22:00:00.000Z',
  to: '2026-09-08T22:00:00.000Z',
};

function ga4Row(key: string, sponsored: boolean, users: number, sessions: number, clicks: number) {
  return {
    dimensionValues: [{ value: key }, { value: sponsored ? 'sponsored' : 'free' }],
    metricValues: [{ value: String(users) }, { value: String(sessions) }, { value: String(clicks) }],
  };
}

describe('aggregateGa4Rows', () => {
  it('excludes sponsored traffic from the free-ads pitch count', () => {
    const rows = aggregateGa4Rows([
      ga4Row('casale-sa', false, 9, 9, 12),
      ga4Row('casale-sa', true, 40, 40, 50),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].applyClickProxy).toBe(9);
    expect(rows[0]).not.toHaveProperty('candidates');
    expect(rows[0].persons).toBe(9);
    expect(rows[0].sessions).toBe(9);
    expect(rows[0].clicks).toBe(12);
    expect(rows[0].sponsored).toBe(40);
  });

  it('applyClickProxy = min(persons, sessions), free-only', () => {
    const rows = aggregateGa4Rows([ga4Row('acme', false, 15, 10, 20)]);
    expect(rows[0].applyClickProxy).toBe(10);
    expect(rows[0]).not.toHaveProperty('candidates');
  });

  it('employer with only sponsored ads gets 0 free proxy signals', () => {
    const rows = aggregateGa4Rows([ga4Row('sponsored-only', true, 25, 25, 30)]);
    expect(rows[0].applyClickProxy).toBe(0);
    expect(rows[0]).not.toHaveProperty('candidates');
    expect(rows[0].sponsored).toBe(25);
  });

  it('returns [] for empty rows', () => {
    expect(aggregateGa4Rows([])).toEqual([]);
    expect(aggregateGa4Rows(undefined as unknown as [])).toEqual([]);
  });

  it('keeps a zero-valued event row in the resolved employer population', () => {
    const companies = new Map([
      ['acme', { key: 'acme', name: 'Acme SA', aliases: new Set(['acme']) }],
    ]);
    const [row] = aggregateGa4Rows([ga4Row('acme', false, 0, 0, 0)]);
    const result = resolveGa4Employers([row], companies);

    expect(result.employers).toHaveLength(1);
    expect(result.employers[0]).toMatchObject({ key: 'acme', observed: 0, applyClicks: 0 });
  });

  it('keeps zero-valued GA4 employers out of the printed table without non-finite totals', () => {
    const companies = new Map([
      ['acme', { key: 'acme', name: 'Acme SA', aliases: new Set(['acme']) }],
    ]);
    const [row] = aggregateGa4Rows([ga4Row('acme', false, 0, 0, 0)]);
    const resolved = resolveGa4Employers([row], companies);
    const payload = reportPayload({
      source: 'ga4',
      window: WINDOW,
      data: {
        coverage: {
          observed: resolved.observed,
          attributed: resolved.attributed,
          residuals: resolved.residuals,
          residualTotal: 0,
          limits: { groups: { limit: 1, pageSize: 1, totalBeforeCut: 1, returned: 1, pages: 1, truncated: false } },
        },
      },
      rows: resolved.employers,
      min: 1,
      days: 90,
    });

    expect(payload.employers).toHaveLength(0);
    expect(payload.totals).toMatchObject({ applyClickProxy: 0, applyClicks: 0, persons: 0, sessions: 0, clicks: 0 });
    expect(JSON.stringify(payload)).not.toMatch(/NaN|Infinity/);
  });
});

describe('postHogBaseQuery', () => {
  it('orders company groups and resumes after an explicit company cursor', () => {
    const firstPage = postHogBaseQuery(WINDOW);
    const nextPage = postHogBaseQuery(WINDOW, 'acme');

    expect(firstPage).toContain('ORDER BY company');
    expect(firstPage).not.toContain('OFFSET');
    expect(nextPage).toContain("> 'acme'");
    expect(nextPage).not.toContain('OFFSET');
  });

  it('compares company cursors with ClickHouse UTF-8 byte ordering', () => {
    const supplementary = String.fromCodePoint(0x10000);
    const privateUseBmp = '\uE000';

    // JavaScript UTF-16 and ClickHouse UTF-8 disagree for this pair; the
    // cursor guard must follow the database ordering, not the JS default.
    expect(supplementary > privateUseBmp).toBe(false);
    expect(comparePostHogCompany(supplementary, privateUseBmp)).toBeGreaterThan(0);
  });
});
