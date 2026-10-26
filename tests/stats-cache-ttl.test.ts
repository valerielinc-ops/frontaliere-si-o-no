import { describe, expect, it } from 'vitest';
import { normalizeStatsCacheEntry, STATS_CACHE_DURATION_MS } from '../services/statsService';

describe('statsService cache TTL', () => {
  it('uses a 1-hour cache window for BFS/UST stats', () => {
    expect(STATS_CACHE_DURATION_MS).toBe(60 * 60 * 1000);
  });

  it('keeps valid points while rejecting malformed cache envelopes', () => {
    const value = normalizeStatsCacheEntry({
      trend: [{ year: '2024-Q3', frontalieri: 10 }, { year: 42, frontalieri: 3 }],
      ages: [{ name: '25-29', value: 4 }],
      genderTrend: [{ year: '2024', Uomini: 3, Donne: 2 }],
      genderSnapshot: [{ name: 'Uomini', value: 3, pct: '60%', color: '#123' }],
      lastUpdated: '2024-10-01T00:00:00.000Z',
      timestamp: 900,
    }, 1_000);
    expect(value?.trend).toEqual([{ year: '2024-Q3', frontalieri: 10 }]);
    expect(normalizeStatsCacheEntry({ trend: [], ages: [], genderTrend: [], genderSnapshot: [], lastUpdated: 'x', timestamp: 900 }, 1_000)).toBeNull();
    expect(normalizeStatsCacheEntry({ trend: [], ages: [], genderTrend: [], genderSnapshot: [], lastUpdated: 'x', timestamp: 1_001 }, 1_000)).toBeNull();
  });
});
