import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXCHANGE_RATE } from '@/constants';
import { Analytics } from '@/services/analytics';

const MODULE = '@/services/exchangeRateService';
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};

beforeEach(async () => {
  storage.clear();
  vi.stubGlobal('localStorage', localStorageMock as Storage);
  vi.resetModules();
  vi.clearAllMocks();
  const reporter = await import('@/services/errorReporter');
  reporter._resetThrottleMapForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchExchangeRate transient endpoint failures', () => {
  it('retries one transport failure and returns the live rate without entering fallback', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, rate: 1.0812 }),
      });
    const mod = await import(MODULE);
    mod.__testing.setFetchImplementation(fetchMock as typeof fetch);
    vi.useFakeTimers();

    const request = mod.fetchExchangeRate();
    await vi.advanceTimersByTimeAsync(200);
    await expect(request).resolves.toBe(1.0812);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0][1]?.signal).not.toBe(fetchMock.mock.calls[1][1]?.signal);
    expect(mod.getRateSource()).toBe('twelvedata');
    expect(Analytics.trackAppError).not.toHaveBeenCalled();
  });

  it('preserves the stale fallback after exhausted retries without emitting a GA4 storm', async () => {
    const fallbackRate = 1.043;
    localStorage.setItem('exchange_rate_cache', JSON.stringify({
      rate: fallbackRate,
      timestamp: Date.now() - 20 * 60 * 1000,
      source: 'cache',
    }));
    const finalFailure = new TypeError('Failed to fetch');
    const failures = [
      new TypeError('Failed to fetch'),
      finalFailure,
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.reject(failures.shift()));
    const mod = await import(MODULE);
    mod.__testing.setFetchImplementation(fetchMock as typeof fetch);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    const firstRequest = mod.fetchExchangeRate();
    await vi.advanceTimersByTimeAsync(200);
    await expect(firstRequest).resolves.toBe(fallbackRate);
    const secondRequest = mod.fetchExchangeRate();
    await vi.advanceTimersByTimeAsync(200);
    await expect(secondRequest).resolves.toBe(fallbackRate);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mod.getRateSource()).toBe('cache');
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenNthCalledWith(1, '[exchangeRate.cfFetch]', finalFailure);
    expect(warning).toHaveBeenNthCalledWith(2, '[exchangeRate.cfFetch]', expect.objectContaining({ message: 'Failed to fetch' }));
    // reportCaughtError keeps local console visibility, but the existing
    // benign filter drops bare transport failures before they reach GA4.
    expect(Analytics.trackAppError).not.toHaveBeenCalled();
  });

  it('aborts a slow attempt without retrying/reporting and returns the default fallback', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const mod = await import(MODULE);
    mod.__testing.setFetchImplementation(fetchMock as typeof fetch);
    vi.useFakeTimers();

    try {
      const request = mod.fetchExchangeRate();
      await vi.advanceTimersByTimeAsync(6000);

      await expect(request).resolves.toBe(DEFAULT_EXCHANGE_RATE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Analytics.trackAppError).not.toHaveBeenCalled();
      expect(mod.getRateSource()).toBe('fallback');
    } finally {
      vi.useRealTimers();
    }
  });
});
