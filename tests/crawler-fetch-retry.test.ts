import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, fetchHtml, fetchHtmlWithCookies } from '../scripts/lib/crawler-template.mjs';

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

  // #4247: the Bucher + Suter WordPress REST job-listings endpoint returned
  // HTTP 200 with an HTML WAF/challenge page body instead of JSON on a CI
  // run, crashing the whole crawler with "Unexpected token '<' ... is not
  // valid JSON" and no retry. fetchJson() must treat a 200-but-non-JSON body
  // as retryable (NOT proxy through Jina — that always returns HTML too).
  it('retries fetchJson on a 200 response with a non-JSON (WAF challenge) body, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(200, '<html><head><title>Just a moment...</title></head></html>'))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 1, title: { rendered: 'Job' } }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('https://example.test/wp-json/wp/v2/job-listings', { retryBaseMs: 0 });
    expect(result).toEqual([{ id: 1, title: { rendered: 'Job' } }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws after a persistent 200-but-non-JSON (WAF challenge) body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(200, '<html><head><title>Blocked</title></head></html>'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchJson('https://example.test/wp-json/wp/v2/job-listings', { retries: 2, retryBaseMs: 0 }),
    ).rejects.toThrow(/Invalid JSON/);
    // 1 initial attempt + 2 retries — still fails loudly, no silent data wipe.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function redirectResponse(status: number, location: string, setCookies: string[] = []) {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookies,
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  } as unknown as Response;
}

function htmlResponseWithHeaders(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => body,
  } as unknown as Response;
}

describe('fetchHtmlWithCookies cookie-challenge handling', () => {
  it('persists the challenge cookie across a redirect chain and returns the final page', async () => {
    // Reproduces the Airlock "AL_CHK" cookie-check that fronts www.ruag.ch:
    //   307 (sets cookie, → /cookie-check) → 307 (→ back) → 200 (real page).
    const seen: Array<{ url: string; cookie: string | undefined; redirect: string | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit & { redirect?: string }) => {
      const cookie = (init.headers as Record<string, string> | undefined)?.Cookie;
      seen.push({ url, cookie, redirect: init.redirect });
      if (seen.length === 1) {
        return redirectResponse(307, '/cookie-check?l=%2Fjobs', ['AL_CHK-S=token123; Path=/; Secure; HttpOnly']);
      }
      if (seen.length === 2) {
        return redirectResponse(307, '/jobs');
      }
      return htmlResponseWithHeaders(200, '<html>jobs</html>');
    });
    vi.stubGlobal('fetch', fetchMock);

    const html = await fetchHtmlWithCookies('https://www.example.test/jobs', { retryBaseMs: 0 });
    expect(html).toBe('<html>jobs</html>');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First hop carries no cookie; later hops resend the absorbed challenge cookie.
    expect(seen[0].cookie).toBeUndefined();
    expect(seen[1].cookie).toContain('AL_CHK-S=token123');
    expect(seen[2].cookie).toContain('AL_CHK-S=token123');
    // Redirects are followed manually so cookies can be re-attached per hop.
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
  });

  it('throws on a hard 4xx without looping forever', async () => {
    const fetchMock = vi.fn(async () => htmlResponseWithHeaders(404, ''));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchHtmlWithCookies('https://www.example.test/jobs', { retries: 0, retryBaseMs: 0 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
