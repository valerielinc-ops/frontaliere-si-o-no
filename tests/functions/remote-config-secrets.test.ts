/**
 * tests/functions/remote-config-secrets.test.ts
 *
 * Regression coverage for #5766: getRemoteConfigValue() must coalesce
 * concurrent getTemplate() reads on a cold/expired cache instead of firing
 * one Remote Config read per concurrent caller — the cache stampede that
 * tripped the project-wide 'Read requests per minute' quota and produced
 * 500s on exchange_auth_code. None of this was covered before: existing
 * tests mock getTemplate() and call getRemoteConfigValue() once, which
 * cannot observe a stampede.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_STALE_MS = 60 * 60 * 1000;
const REMOTE_CONFIG_FETCH_TIMEOUT_MS = 8 * 1000;

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('getRemoteConfigValue — in-flight coalescing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires a single getTemplate() call for concurrent readers on a cold cache', async () => {
    let calls = 0;
    let resolveTemplate: (t: unknown) => void;
    const templatePromise = new Promise((resolve) => { resolveTemplate = resolve; });

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          return templatePromise;
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    const readers = Promise.all([
      getRemoteConfigValue('A'),
      getRemoteConfigValue('B'),
      getRemoteConfigValue('C'),
    ]);

    expect(calls).toBe(1);
    resolveTemplate!({
      parameters: {
        A: { defaultValue: { value: 'a' } },
        B: { defaultValue: { value: 'b' } },
        C: { defaultValue: { value: 'c' } },
      },
    });

    const results = await readers;
    expect(results).toEqual(['a', 'b', 'c']);
    expect(calls).toBe(1);
  });

  it('rejects every concurrent reader and clears the in-flight slot so the next call retries fresh', async () => {
    let calls = 0;

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: async () => {
          calls += 1;
          if (calls === 1) throw new Error('quota exceeded');
          return { parameters: { A: { defaultValue: { value: 'ok' } } } };
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    await expect(Promise.all([
      getRemoteConfigValue('A'),
      getRemoteConfigValue('A'),
    ])).rejects.toThrow('quota exceeded');
    expect(calls).toBe(1);

    // A failed fetch must not stay stuck: the next call retries instead of
    // awaiting a dead/rejected in-flight promise forever.
    const value = await getRemoteConfigValue('A');
    expect(value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent readers again once the cache has expired', async () => {
    let calls = 0;
    let resolveRefresh: (t: unknown) => void;
    const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ parameters: { A: { defaultValue: { value: 'v1' } } } });
          return refreshPromise;
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    expect(await getRemoteConfigValue('A')).toBe('v1');
    expect(calls).toBe(1);

    // Advance past the 5-minute TTL.
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);

    const results = await Promise.all([
      getRemoteConfigValue('A'),
      getRemoteConfigValue('A'),
    ]);
    expect(results).toEqual(['v1', 'v1']);
    expect(calls).toBe(2);

    resolveRefresh!({ parameters: { A: { defaultValue: { value: 'v2' } } } });
    await refreshPromise;
    await flushMicrotasks();
    expect(await getRemoteConfigValue('A')).toBe('v2');
  });

  it('returns the stale value immediately while one background refresh runs', async () => {
    let calls = 0;
    let resolveRefresh: (t: unknown) => void;
    const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ parameters: { A: { defaultValue: { value: 'old' } } } });
          return refreshPromise;
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    expect(await getRemoteConfigValue('A')).toBe('old');
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);

    const staleRead = getRemoteConfigValue('A');
    await expect(staleRead).resolves.toBe('old');
    expect(calls).toBe(2);

    resolveRefresh!({ parameters: { A: { defaultValue: { value: 'new' } } } });
    await refreshPromise;
    await flushMicrotasks();
    expect(await getRemoteConfigValue('A')).toBe('new');
  });

  it('rejects a cold read on timeout and lets the next call retry', async () => {
    let calls = 0;
    const hangingFetch = new Promise(() => {});

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          if (calls === 1) return hangingFetch;
          return Promise.resolve({ parameters: { A: { defaultValue: { value: 'recovered' } } } });
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    const firstRead = getRemoteConfigValue('A');
    const firstReadError = expect(firstRead).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(REMOTE_CONFIG_FETCH_TIMEOUT_MS);
    await firstReadError;
    expect(calls).toBe(1);

    await expect(getRemoteConfigValue('A')).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('serves the cached value when a too-old refresh times out', async () => {
    let calls = 0;
    const hangingFetch = new Promise(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ parameters: { A: { defaultValue: { value: 'old' } } } });
          return hangingFetch;
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    expect(await getRemoteConfigValue('A')).toBe('old');
    vi.advanceTimersByTime(CACHE_MAX_STALE_MS + 1);

    const staleRead = getRemoteConfigValue('A');
    await vi.advanceTimersByTimeAsync(REMOTE_CONFIG_FETCH_TIMEOUT_MS);
    await expect(staleRead).resolves.toBe('old');
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('keeps the cached value when a background refresh fails', async () => {
    let calls = 0;
    let resolveThirdRefresh: (t: unknown) => void;
    const thirdRefresh = new Promise((resolve) => { resolveThirdRefresh = resolve; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ parameters: { A: { defaultValue: { value: 'old' } } } });
          if (calls === 2) return Promise.reject(new Error('temporary failure'));
          return thirdRefresh;
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    expect(await getRemoteConfigValue('A')).toBe('old');
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    await expect(getRemoteConfigValue('A')).resolves.toBe('old');
    await flushMicrotasks();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalled();

    // The failed refresh must not turn the cache into a cold read. A new
    // refresh may start, but this caller still gets the retained value now.
    const afterFailure = getRemoteConfigValue('A');
    await expect(afterFailure).resolves.toBe('old');
    expect(calls).toBe(3);

    resolveThirdRefresh!({ parameters: { A: { defaultValue: { value: 'old' } } } });
    await thirdRefresh;
    await flushMicrotasks();
  });
});
