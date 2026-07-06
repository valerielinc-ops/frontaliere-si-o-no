/**
 * Regression tests for the localStorage-freshness-first cache checks and
 * in-flight promise memoization in exchangeRateService.ts.
 *
 * localStorage-first: skip a Firestore read on every fresh page load when a
 * recent local copy already exists (calculator pages are a high-traffic surface;
 * every visitor was paying a Firestore read even seconds after another page view
 * fetched the same value in the same browser).
 *
 * In-flight dedup: multiple components mounting in the same tick can each race
 * past the local-cache check before memoryRate is set, each issuing their own
 * Firestore read. The module-level ratePromise/historyPromiseMap ensures only
 * one network round-trip runs per cache-miss window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const MODULE = '@/services/exchangeRateService';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('fetchExchangeRate — fresh localStorage cache', () => {
  it('returns the cached rate without falling back to the hardcoded default, and skips Firestore/TwelveData entirely', async () => {
    localStorage.setItem('exchange_rate_cache', JSON.stringify({
      rate: 0.987,
      timestamp: Date.now(),
      source: 'twelvedata',
    }));
    const mod = await import(MODULE);
    const rate = await mod.fetchExchangeRate();
    expect(rate).toBe(0.987);
    // Discriminates the fix: pre-fix code unconditionally called Firestore
    // (then TwelveData) before ever consulting a fresh local cache, so this
    // would be >0 without the localStorage-first short-circuit.
    expect(mod.__testing.firestoreRateCalls).toBe(0);
    expect(mod.__testing.twelveDataCalls).toBe(0);
  });

  it('falls through to Firestore/TwelveData when the local cache is missing (proves the counters actually discriminate)', async () => {
    const mod = await import(MODULE);
    const rate = await mod.fetchExchangeRate();
    expect(typeof rate).toBe('number');
    expect(rate).toBeGreaterThan(0);
    expect(mod.__testing.firestoreRateCalls).toBeGreaterThan(0);
    expect(mod.__testing.twelveDataCalls).toBeGreaterThan(0);
  });
});

describe('fetchExchangeHistory — fresh localStorage cache', () => {
  it('returns the cached points as-is when fetched within the last 6h, and skips the Firestore read entirely', async () => {
    const points = [
      { date: '2026-06-01', rate: 0.9 },
      { date: '2026-06-02', rate: 0.91 },
    ];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-06-02',
      fetchedAt: Date.now(),
    }));
    const mod = await import(MODULE);
    const result = await mod.fetchExchangeHistory('1m');
    expect(result).toEqual(points);
    // Discriminates the fix: pre-fix code called Firestore unconditionally
    // before ever checking local-cache freshness.
    expect(mod.__testing.firestoreHistoryCalls).toBe(0);
  });

  it('appends the live rate as an extra point on top of the fresh cache', async () => {
    const points = [{ date: '2026-06-01', rate: 0.9 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-06-01',
      fetchedAt: Date.now(),
    }));
    const mod = await import(MODULE);
    const result = await mod.fetchExchangeHistory('1m', 0.95);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1].rate).toBe(0.95);
    expect(mod.__testing.firestoreHistoryCalls).toBe(0);
  });

  it('legacy cache entries without fetchedAt (pre-fix) still resolve via the age-agnostic fallback, but DO hit Firestore first (proves the counter discriminates)', async () => {
    const points = [{ date: '2026-05-01', rate: 0.111 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-05-01',
      // no fetchedAt — simulates a cache entry written before this fix shipped
    }));
    const mod = await import(MODULE);
    const result = await mod.fetchExchangeHistory('1m');
    expect(result).toEqual(points);
    expect(mod.__testing.firestoreHistoryCalls).toBeGreaterThan(0);
  });
});

describe('fetchExchangeRate — in-flight promise dedup', () => {
  it('concurrent calls share one Firestore read and one TwelveData call', async () => {
    // No localStorage: both calls miss the fast path and race to the network layer.
    // Without dedup each would issue its own Firestore read before memoryRate is set.
    const mod = await import(MODULE);
    const [r1, r2] = await Promise.all([mod.fetchExchangeRate(), mod.fetchExchangeRate()]);
    // Both callers get the same rate (IS_TEST_ENV → DEFAULT_RATE 0.94)
    expect(r1).toBe(r2);
    expect(typeof r1).toBe('number');
    // Dedup: only ONE Firestore read despite two concurrent calls
    expect(mod.__testing.firestoreRateCalls).toBe(1);
    expect(mod.__testing.twelveDataCalls).toBe(1);
  });
});

describe('fetchExchangeHistory — in-flight promise dedup', () => {
  it('concurrent calls for the same period share one Firestore read', async () => {
    // Stale localStorage (no fetchedAt) to skip the fresh-cache short-circuit
    // but avoid live Frankfurter API calls (stale entry serves as offline fallback)
    const points = [{ date: '2026-06-01', rate: 0.9 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({
      points,
      lastDate: '2026-06-01',
    }));
    const mod = await import(MODULE);
    const [h1, h2] = await Promise.all([
      mod.fetchExchangeHistory('1m'),
      mod.fetchExchangeHistory('1m'),
    ]);
    expect(h1).toEqual(points);
    expect(h2).toEqual(points);
    // Dedup: only ONE Firestore read for '1m' despite two concurrent calls
    expect(mod.__testing.firestoreHistoryCalls).toBe(1);
  });

  it('concurrent calls for different periods each get their own Firestore read (no cross-period dedup)', async () => {
    const points1m = [{ date: '2026-06-01', rate: 0.9 }];
    const points3m = [{ date: '2026-04-01', rate: 0.88 }];
    localStorage.setItem('ft_exchange_history_1m', JSON.stringify({ points: points1m, lastDate: '2026-06-01' }));
    localStorage.setItem('ft_exchange_history_3m', JSON.stringify({ points: points3m, lastDate: '2026-04-01' }));
    const mod = await import(MODULE);
    await Promise.all([
      mod.fetchExchangeHistory('1m'),
      mod.fetchExchangeHistory('3m'),
    ]);
    // Two different periods → two independent Firestore reads
    expect(mod.__testing.firestoreHistoryCalls).toBe(2);
  });
});
