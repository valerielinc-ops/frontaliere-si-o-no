import { describe, expect, it, vi } from 'vitest';

import { fetchGoogleTrendsCandidates } from '../../../scripts/lib/topic-sources/googleTrends.mjs';

describe('fetchGoogleTrendsCandidates RSS timeout', () => {
  it('bounds a stalled response body and cancels its stream', async () => {
    const cancel = vi.fn(async () => undefined);
    const bodies: ReadableStream<Uint8Array>[] = [];
    const responseTexts: ReturnType<typeof vi.fn>[] = [];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      const body = new ReadableStream<Uint8Array>({ cancel });
      bodies.push(body);
      const responseText = vi.fn(() => {
        // Simulate the old response.text() path having already locked the body.
        body.getReader();
        return new Promise<string>(() => {});
      });
      responseTexts.push(responseText);
      return {
        ok: true,
        status: 200,
        body,
        text: responseText,
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
    expect(responseTexts.every((responseText) => !responseText.mock.calls.length)).toBe(true);
    expect(bodies.every((body) => !body.locked)).toBe(true);
  });
});
