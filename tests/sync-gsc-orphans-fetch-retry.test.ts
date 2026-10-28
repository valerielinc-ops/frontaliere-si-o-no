import { describe, expect, it, vi } from 'vitest';

import { fetchGsc } from '../scripts/lib/gsc-fetch.mjs';

describe('GSC Search Analytics bounded retries', () => {
  it('retries a transient network failure before returning the response', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] }), { status: 200 }));

    const response = await fetchGsc('https://gsc.test/query', { method: 'POST' }, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries transient HTTP failures and preserves the final response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] }), { status: 200 }));

    const response = await fetchGsc('https://gsc.test/query', { method: 'POST' }, {
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed after exhausting transient HTTP retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('busy', { status: 503 }),
    );

    await expect(
      fetchGsc('https://gsc.test/query', { method: 'POST' }, {
        fetchImpl,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('GSC request failed after 3 attempts: HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails with a clear error after repeated timeouts', async () => {
    const fetchImpl = vi.fn((_url, { signal }: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true });
      }));

    await expect(
      fetchGsc('https://gsc.test/query', { method: 'POST' }, {
        fetchImpl,
        timeoutMs: 1,
        attempts: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('GSC request timed out after 1 ms');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
