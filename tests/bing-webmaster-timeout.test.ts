import { describe, expect, it } from 'vitest';
import {
  getBingFeeds,
  getBingRankAndTrafficStats,
  getBingUrlSubmissionQuota,
} from '../scripts/lib/bing-webmaster.mjs';

describe('Bing Webmaster transport deadline', () => {
  it('aborts a request that never returns headers', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<never>(() => {});
    };

    await expect(
      getBingUrlSubmissionQuota('key', 'https://frontaliereticino.ch', { fetchImpl, timeoutMs: 10 }),
    ).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('applies the same deadline while reading the response body', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return Promise.resolve({ ok: true, json: () => new Promise<never>(() => {}) });
    };

    await expect(
      getBingFeeds('key', 'https://frontaliereticino.ch', { fetchImpl, timeoutMs: 10 }),
    ).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('preserves the existing result shapes for valid responses', async () => {
    const fetchImpl = (url: string) => {
      if (url.includes('GetUrlSubmissionQuota')) {
        return Promise.resolve({ ok: true, json: async () => ({ d: { DailyQuota: 12, MonthlyQuota: 34 } }) });
      }
      if (url.includes('GetFeeds')) {
        return Promise.resolve({ ok: true, json: async () => ({ d: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ d: [] }) });
    };

    await expect(
      getBingUrlSubmissionQuota('key', 'https://frontaliereticino.ch', { fetchImpl, timeoutMs: 100 }),
    ).resolves.toEqual({ dailyQuota: 12, monthlyQuota: 34 });
    await expect(
      getBingFeeds('key', 'https://frontaliereticino.ch', { fetchImpl, timeoutMs: 100 }),
    ).resolves.toEqual([]);
    await expect(
      getBingRankAndTrafficStats('key', 'https://frontaliereticino.ch', { fetchImpl, timeoutMs: 100 }),
    ).resolves.toEqual([]);
  });
});
