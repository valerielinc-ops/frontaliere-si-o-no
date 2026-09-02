import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_DELAY_MS } from '../scripts/lib/prospector/config.mjs';
import {
  clearPoliteFetchStateForTests,
  politeFetch,
} from '../scripts/lib/prospector/polite-fetch.mjs';

function response(
  url: string,
  status: number,
  { body = '', retryAfter = null }: { body?: string; retryAfter?: string | null } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name: string) => name.toLowerCase() === 'retry-after' ? retryAfter : null,
    },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const identityPolicy = async (url: string) => url;

describe('prospector polite fetch retry cooldown', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it.each([
    ['delta seconds', (now: number) => '4', 4_000],
    ['HTTP date', (now: number) => new Date(now + 7_000).toUTCString(), 7_000],
  ])('honours bounded Retry-After in %s form', async (_label, header, expectedDelay) => {
    const url = 'https://jobs.example.test/openings';
    let now = Date.UTC(2026, 8, 1, 10, 0, 0);
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => attempts++ === 0
      ? response(url, 429, { retryAfter: header(now) })
      : response(url, 200, { body: '<h1>Recovered</h1>' }));

    const result = await politeFetch(url, {
      fetchImpl,
      urlPolicy: identityPolicy,
      ignoreRobots: true,
      retries: 1,
      retryBaseMs: 500,
      nowImpl: () => now,
      sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([expectedDelay]);
  });

  it('starts each network timeout after waiting out the Retry-After cooldown', async () => {
    vi.useFakeTimers();
    try {
      const url = 'https://jobs.example.test/openings';
      let now = Date.UTC(2026, 8, 1, 10, 0, 0);
      let attempts = 0;
      const signals: AbortSignal[] = [];
      const fetchImpl = vi.fn(async (_target: string, init: RequestInit = {}) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        return attempts++ === 0
          ? response(url, 429, { retryAfter: '1' })
          : response(url, 200, { body: '<h1>Recovered</h1>' });
      });
      const request = politeFetch(url, {
        fetchImpl,
        urlPolicy: identityPolicy,
        ignoreRobots: true,
        retries: 1,
        timeoutMs: 10,
        nowImpl: () => now,
        sleepImpl: (ms) => new Promise((resolve) => {
          setTimeout(() => { now += ms; resolve(undefined); }, ms);
        }),
      });

      await vi.runAllTimersAsync();

      await expect(request).resolves.toMatchObject({ ok: true, status: 200 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(attempts).toBe(2);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, 'not-a-date'])(
    'caps the local fallback when Retry-After is %s',
    async (retryAfter) => {
      const url = 'https://jobs.example.test/openings';
      let now = Date.UTC(2026, 8, 1, 10, 0, 0);
      let attempts = 0;
      const sleeps: number[] = [];
      const fetchImpl = vi.fn(async () => attempts++ === 0
        ? response(url, 429, { retryAfter })
        : response(url, 200));

      const result = await politeFetch(url, {
        fetchImpl,
        urlPolicy: identityPolicy,
        ignoreRobots: true,
        retries: 1,
        retryBaseMs: 90_000,
        nowImpl: () => now,
        sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
      });

      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(attempts).toBe(2);
      expect(sleeps).toEqual([60_000]);
    },
  );

  it('honours an explicit Retry-After even when it is shorter than the scaled local fallback', async () => {
    const url = 'https://jobs.example.test/openings';
    let now = Date.UTC(2026, 8, 1, 10, 0, 0);
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => attempts++ === 0
      ? response(url, 429, { retryAfter: '2' })
      : response(url, 200, { body: '<h1>Recovered</h1>' }));

    const result = await politeFetch(url, {
      fetchImpl,
      urlPolicy: identityPolicy,
      ignoreRobots: true,
      retries: 1,
      // A large retryBaseMs means the scaled local fallback (retryBaseMs *
      // (attempt+1)) would dwarf the 2s header if the fallback still won.
      // The header (2000ms) still clears the HOST_DELAY_MS floor that
      // throttle() applies to every request regardless of Retry-After.
      retryBaseMs: 10_000,
      nowImpl: () => now,
      sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it('keeps robots fail-open while applying its 429 cooldown before the target request', async () => {
    const url = 'https://jobs.example.test/openings';
    let now = 100_000;
    const requests: Array<{ url: string; at: number }> = [];
    const fetchImpl = vi.fn(async (requestedUrl: string) => {
      requests.push({ url: requestedUrl, at: now });
      return requestedUrl.endsWith('/robots.txt')
        ? response(requestedUrl, 429, { retryAfter: '2' })
        : response(requestedUrl, 200);
    });

    await expect(politeFetch(url, {
      fetchImpl,
      urlPolicy: identityPolicy,
      retries: 0,
      nowImpl: () => now,
      sleepImpl: async (ms) => { now += ms; },
    })).resolves.toMatchObject({ ok: true, status: 200 });

    expect(requests).toEqual([
      { url: 'https://jobs.example.test/robots.txt', at: 100_000 },
      { url, at: 102_000 },
    ]);
  });

  it('extends a queued sibling worker when another request publishes a host cooldown', async () => {
    const firstUrl = 'https://jobs.example.test/first';
    const secondUrl = 'https://jobs.example.test/second';
    const firstResponse = deferred<any>();
    const firstStarted = deferred<void>();
    const secondQueued = deferred<void>();
    let releaseSecondSlot: (() => void) | undefined;
    let now = 100_000;
    const requests: Array<{ url: string; at: number }> = [];
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push({ url, at: now });
      if (url === firstUrl) {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      return response(url, 200);
    });
    const sleepImpl = vi.fn((ms: number) => {
      sleeps.push(ms);
      if (!releaseSecondSlot) {
        secondQueued.resolve();
        return new Promise<void>((resolve) => {
          releaseSecondSlot = () => { now += ms; resolve(); };
        });
      }
      now += ms;
      return Promise.resolve();
    });
    const options = {
      fetchImpl,
      urlPolicy: identityPolicy,
      ignoreRobots: true,
      retries: 0,
      nowImpl: () => now,
      sleepImpl,
    };

    const first = politeFetch(firstUrl, options);
    await firstStarted.promise;
    const second = politeFetch(secondUrl, options);
    await secondQueued.promise;
    firstResponse.resolve(response(firstUrl, 429, { retryAfter: '5' }));
    await first;
    releaseSecondSlot?.();
    await expect(second).resolves.toMatchObject({ ok: true, status: 200 });

    expect(requests).toEqual([
      { url: firstUrl, at: 100_000 },
      { url: secondUrl, at: 105_000 },
    ]);
    expect(sleeps).toEqual([HOST_DELAY_MS, 5_000 - HOST_DELAY_MS]);
  });

  it.each([408, 425, 500, 502, 503, 504])(
    'preserves the bounded retry contract for sibling transient HTTP %s',
    async (status) => {
      const url = `https://jobs-${status}.example.test/openings`;
      let now = 100_000;
      let attempts = 0;
      const fetchImpl = vi.fn(async () => attempts++ === 0
        ? response(url, status)
        : response(url, 200));

      const result = await politeFetch(url, {
        fetchImpl,
        urlPolicy: identityPolicy,
        ignoreRobots: true,
        retries: 1,
        retryBaseMs: 100,
        nowImpl: () => now,
        sleepImpl: async (ms) => { now += ms; },
      });

      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(attempts).toBe(2);
    },
  );

  it('keeps persistent client failures fail-closed without retrying', async () => {
    const url = 'https://jobs.example.test/missing';
    const fetchImpl = vi.fn(async () => response(url, 404));

    await expect(politeFetch(url, {
      fetchImpl,
      urlPolicy: identityPolicy,
      ignoreRobots: true,
      retries: 3,
      sleepImpl: async () => {},
    })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
