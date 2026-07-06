/**
 * Regression tests for the localStorage-freshness-first cache checks in
 * exchangeRateService.ts — added to skip a Firestore read on every fresh
 * page load when a recent local copy already exists (calculator pages are
 * a high-traffic surface; every visitor to any of them was paying a
 * Firestore read even seconds after another page view fetched the same
 * value in the same browser).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const MODULE = '@/services/exchangeRateService';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('fetchExchangeRate — fresh localStorage cache', () => {
  it('returns the cached rate without falling back to the hardcoded default', async () => {
    localStorage.setItem('exchange_rate_cache', JSON.stringify({
      rate: 0.987,
      timestamp: Date.now(),
      source: 'twelvedata',
    }));
    const { fetchExchangeRate } = await import(MODULE);
    const rate = await fetchExchangeRate();
    expect(rate).toBe(0.987);
  });

  it('does not crash when the local cache is missing (falls through to default)', async () => {
    const { fetchExchangeRate } = await import(MODULE);
    const rate = await fetchExchangeRate();
    expect(typeof rate).toBe('number');
    expect(rate).toBeGreaterThan(0);
  });
});

describe('fetchExchangeHistory — fresh localStorage cache', () => {
  it('returns the cached points as-is when fetched within the last 6h', async () => {
    const points = [
      { date: '2026-06-01', rate: 0.9 },
      { date: '2026-06-02', rate: 0.91 },
    ];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-06-02',
      fetchedAt: Date.now(),
    }));
    const { fetchExchangeHistory } = await import(MODULE);
    const result = await fetchExchangeHistory('1m');
    expect(result).toEqual(points);
  });

  it('appends the live rate as an extra point on top of the fresh cache', async () => {
    const points = [{ date: '2026-06-01', rate: 0.9 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-06-01',
      fetchedAt: Date.now(),
    }));
    const { fetchExchangeHistory } = await import(MODULE);
    const result = await fetchExchangeHistory('1m', 0.95);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1].rate).toBe(0.95);
  });

  it('legacy cache entries without fetchedAt (pre-fix) still resolve via the age-agnostic fallback', async () => {
    const points = [{ date: '2026-05-01', rate: 0.111 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-05-01',
      // no fetchedAt — simulates a cache entry written before this fix shipped
    }));
    const { fetchExchangeHistory } = await import(MODULE);
    const result = await fetchExchangeHistory('1m');
    expect(result).toEqual(points);
  });
});
