import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAplusPageFetcher } from '../scripts/lib/a-plus-plus-fetch.mjs';

function htmlResponse(body: string, setCookies: string[] = []) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null,
      getSetCookie: () => setCookies,
    },
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A++ page fetcher', () => {
  it('carries the listing session and same-site referrer into detail requests', async () => {
    const listingUrl = 'https://inrecruiting.intervieweb.it/a2plus/en/career';
    const detailUrl = 'https://inrecruiting.intervieweb.it/a2plus/jobs/role-724674/en/';
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return htmlResponse('<html>live vacancy</html>', seen.length === 1
        ? ['intervieweb_session=session-1; Path=/; Secure']
        : []);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fetchPage = createAplusPageFetcher({
      listingUrl,
      userAgent: 'A++ test browser',
    });

    await fetchPage(listingUrl, 1_000);
    await fetchPage(detailUrl, 1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen[1].headers.Cookie).toContain('intervieweb_session=session-1');
    expect(seen[1].headers.Referer).toBe(listingUrl);
    expect(seen[1].headers['Sec-Fetch-Mode']).toBe('navigate');
  });
});
