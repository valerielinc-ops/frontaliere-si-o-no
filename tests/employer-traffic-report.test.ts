import { describe, it, expect } from 'vitest';
import { aggregateGa4Rows } from '../scripts/employer-traffic-report.mjs';

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
    expect(rows[0].candidates).toBe(9);
    expect(rows[0].persons).toBe(9);
    expect(rows[0].sessions).toBe(9);
    expect(rows[0].clicks).toBe(12);
    expect(rows[0].sponsored).toBe(40);
  });

  it('candidates = min(persons, sessions), free-only', () => {
    const rows = aggregateGa4Rows([ga4Row('acme', false, 15, 10, 20)]);
    expect(rows[0].candidates).toBe(10);
  });

  it('employer with only sponsored ads gets 0 free candidates', () => {
    const rows = aggregateGa4Rows([ga4Row('sponsored-only', true, 25, 25, 30)]);
    expect(rows[0].candidates).toBe(0);
    expect(rows[0].sponsored).toBe(25);
  });

  it('returns [] for empty rows', () => {
    expect(aggregateGa4Rows([])).toEqual([]);
    expect(aggregateGa4Rows(undefined as unknown as [])).toEqual([]);
  });
});
