import { describe, expect, it, vi } from 'vitest';

import { fetchGoogleTrendsCandidates } from '../../../scripts/lib/topic-sources/googleTrends.mjs';

describe('fetchGoogleTrendsCandidates RSS timeout', () => {
  it('bounds a stalled response body and cancels its stream', async () => {
    const cancel = vi.fn(async () => undefined);
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return {
        ok: true,
        status: 200,
        body: { cancel },
        text: () => new Promise<string>(() => {}),
      };
    });
    const googleTrendsImpl = {
      relatedQueries: vi.fn(async () =>
        JSON.stringify({
          default: {
            rankedList: [{ rankedKeyword: [] }, { rankedKeyword: [] }],
          },
        }),
      ),
    };

    const result = await fetchGoogleTrendsCandidates({
      fetchImpl,
      googleTrendsImpl,
      playwrightFallback: async () => [],
      sleepFn: async () => undefined,
      rssRequestTimeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
