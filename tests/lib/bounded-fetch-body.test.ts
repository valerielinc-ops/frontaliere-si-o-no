/**
 * `fetchBodyWithDeadline` races the fetch AND the body read against one timer.
 *
 * The bug class (hotfix 7ba2e5a, #4118; issues 12714-12718): a timer cleared
 * once the headers arrive leaves `await res.text()` with no deadline, so a
 * body that stalls holds the create-article run until the job timeout. The
 * stall cases below use bodies that ignore the abort signal, which is the
 * worst case: only the race and the body cancel can end them.
 *
 * Synthetic responses only: no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBodyWithDeadline } from '../../scripts/lib/bounded-fetch-body.mjs';
import { fetchSuggestCandidates } from '../../scripts/lib/topic-sources/googleSuggest.mjs';
import { fetchNewsRssCandidates } from '../../scripts/lib/topic-sources/googleNewsRss.mjs';

const encoder = new TextEncoder();

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Sends one chunk, then never sends more and never closes. */
function stalledStream() {
  const stats = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('<rss>'));
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchBodyWithDeadline', () => {
  it('reads a streamed body as text, across chunk boundaries', async () => {
    const fetchImpl = vi.fn(async () => new Response(streamOf(['["a",', '["caff', 'è"]]'])));
    const { response, body } = await fetchBodyWithDeadline(fetchImpl, 'https://x.test', {}, 1000);
    expect(response.ok).toBe(true);
    expect(body).toBe('["a",["caffè"]]');
  });

  it('parses JSON with as: json, from a stream or from a json()-only mock', async () => {
    const streamed = await fetchBodyWithDeadline(
      async () => new Response(streamOf(['{"a":', '1}'])),
      'https://x.test',
      {},
      1000,
      { as: 'json' },
    );
    expect(streamed.body).toEqual({ a: 1 });
    const mocked = await fetchBodyWithDeadline(
      async () => ({ ok: true, json: async () => ({ b: 2 }) }),
      'https://x.test',
      {},
      1000,
      { as: 'json' },
    );
    expect(mocked.body).toEqual({ b: 2 });
  });

  it('does not read the body of a non-ok response', async () => {
    const text = vi.fn(async () => 'error page');
    const { response, body } = await fetchBodyWithDeadline(
      async () => ({ ok: false, status: 503, text }),
      'https://x.test',
      {},
      1000,
    );
    expect(response.status).toBe(503);
    expect(body).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it('passes the init through and adds the abort signal', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => ({ ok: true, text: async () => 'ok' }));
    await fetchBodyWithDeadline(fetchImpl, 'https://x.test', { headers: { A: '1' } }, 1000);
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers).toEqual({ A: '1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects at the deadline and cancels a streamed body that stalls after the headers', async () => {
    const { stream, stats } = stalledStream();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      signal = init.signal;
      return new Response(stream);
    });
    const started = Date.now();
    await expect(fetchBodyWithDeadline(fetchImpl, 'https://x.test', {}, 50)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
    expect(stats.cancelled).toBe(true);
  });

  it('rejects at the deadline when text() ignores the abort signal', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: () => new Promise<string>(() => {}) }));
    const started = Date.now();
    await expect(fetchBodyWithDeadline(fetchImpl, 'https://x.test', {}, 50)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects at the deadline when fetch itself never resolves', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    await expect(fetchBodyWithDeadline(fetchImpl, 'https://x.test', {}, 50)).rejects.toThrow(/deadline/);
  });

  it('rejects invalid JSON without waiting for the deadline', async () => {
    const started = Date.now();
    await expect(
      fetchBodyWithDeadline(async () => new Response('not json'), 'https://x.test', {}, 10_000, { as: 'json' }),
    ).rejects.toThrow(SyntaxError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('topic sources on the create-article path end a stalled body', () => {
  const stalledFetch = () =>
    vi.fn(async () => ({ ok: true, status: 200, text: () => new Promise<string>(() => {}) }));

  it('googleSuggest: a stalled body becomes a per-seed failure, not a hang', async () => {
    vi.useFakeTimers();
    const fetchImpl = stalledFetch();
    const pending = fetchSuggestCandidates({ seeds: ['frontaliere'], fetchImpl: fetchImpl as any });
    // 2 attempts x 5s deadline + 0.75s retry delay.
    await vi.advanceTimersByTimeAsync(2 * 5000 + 750);
    const r = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.perSeed.frontaliere.reason).toMatch(/deadline/);
  });

  it('googleNewsRss: a stalled body becomes a per-seed failure, not a hang', async () => {
    vi.useFakeTimers();
    const fetchImpl = stalledFetch();
    const pending = fetchNewsRssCandidates({ seeds: ['frontaliere'], fetchImpl: fetchImpl as any });
    // 2 attempts x 15s deadline + 1.5s retry delay.
    await vi.advanceTimersByTimeAsync(2 * 15_000 + 1500);
    const r = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.perSeed.frontaliere.reason).toMatch(/deadline/);
  });
});
