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

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('getRemoteConfigValue — in-flight coalescing', () => {
  beforeEach(() => {
    vi.resetModules();
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
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);

    vi.doMock('firebase-admin/remote-config', () => ({
      getRemoteConfig: () => ({
        getTemplate: async () => {
          calls += 1;
          return { parameters: { A: { defaultValue: { value: `v${calls}` } } } };
        },
      }),
    }));

    const { getRemoteConfigValue } = await import('../../functions/src/remoteConfigSecrets.js');

    expect(await getRemoteConfigValue('A')).toBe('v1');
    expect(calls).toBe(1);

    // Advance past the 5-minute TTL.
    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000);

    const results = await Promise.all([
      getRemoteConfigValue('A'),
      getRemoteConfigValue('A'),
    ]);
    expect(results).toEqual(['v2', 'v2']);
    expect(calls).toBe(2);

    nowSpy.mockRestore();
  });
});
