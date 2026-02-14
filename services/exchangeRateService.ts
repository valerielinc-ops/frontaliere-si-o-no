/**
 * Shared Exchange Rate Service
 * Fetches CHF/EUR rate from frankfurter.app API (same as CurrencyExchange component)
 * Used across ShoppingCalculator, CostOfLiving, and other components
 */

import { useState, useEffect } from 'react';

const API_URL = 'https://api.frankfurter.app/latest?from=CHF&to=EUR';
const CACHE_KEY = 'exchange_rate_cache';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  rate: number;
  timestamp: number;
}

/**
 * Get cached rate from localStorage if still fresh
 */
function getCachedRate(): number | null {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    const entry: CacheEntry = JSON.parse(cached);
    if (Date.now() - entry.timestamp < CACHE_DURATION) {
      return entry.rate;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Save rate to localStorage cache
 */
function setCachedRate(rate: number): void {
  try {
    const entry: CacheEntry = { rate, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // ignore
  }
}

/**
 * Fetch the latest CHF to EUR exchange rate from frankfurter.app
 */
export async function fetchExchangeRate(): Promise<number> {
  // Check cache first
  const cached = getCachedRate();
  if (cached) return cached;

  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    if (data?.rates?.EUR) {
      const rate = data.rates.EUR as number;
      setCachedRate(rate);
      return rate;
    }
  } catch (e) {
    console.error('Failed to fetch exchange rate:', e);
  }

  // Fallback: try cache even if expired
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return JSON.parse(cached).rate;
  } catch {
    // ignore
  }

  // Final fallback
  return 0.94;
}

/**
 * React hook to get the live CHF/EUR exchange rate
 * Returns [rate, loading, lastUpdate]
 */
export function useExchangeRate(): {
  rate: number;
  loading: boolean;
  lastUpdate: Date | null;
} {
  const [rate, setRate] = useState<number>(() => getCachedRate() || 0.94);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setLoading(true);
      try {
        const r = await fetchExchangeRate();
        if (mounted) {
          setRate(r);
          setLastUpdate(new Date());
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();

    // Refresh every 5 minutes
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return { rate, loading, lastUpdate };
}
