import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, fetchHtml } from '../scripts/lib/crawler-template.mjs';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('crawler fetch retry/backoff', () => {
  it('retries fetchJson on transient 503 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('https://example.test/api', { retryBaseMs: 0 });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries fetchJson on 429 rate-limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('https://example.test/api', { retryBaseMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast on 404 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJson('https://example.test/api', { retryBaseMs: 0 })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries fetchHtml on a transient network error then succeeds', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(htmlResponse(200, '<html>ok</html>'));
    vi.stubGlobal('fetch', fetchMock);

    const html = await fetchHtml('https://example.test/page', { retryBaseMs: 0 });
    expect(html).toBe('<html>ok</html>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws after persistent 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(503, ''));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchHtml('https://example.test/page', { retries: 2, retryBaseMs: 0 }),
    ).rejects.toThrow(/HTTP 503/);
    // 1 initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours retries: 0 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJson('https://example.test/api', { retries: 0, retryBaseMs: 0 })).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
