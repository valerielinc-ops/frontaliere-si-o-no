import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAplusPageFetcher } from '../scripts/lib/a-plus-plus-fetch.mjs';
import { parseAplusJobDetail } from '../scripts/lib/a-plus-plus-job-parser.mjs';

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
      return htmlResponse('<div class="vacancy__render">live vacancy</div>', seen.length === 1
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

  it('keeps the shared rescue path when a listing challenge returns HTTP 200', async () => {
    const listingUrl = 'https://inrecruiting.intervieweb.it/a2plus/en/career';
    const rescuedListing = `<div class="vacancy__render">${'live vacancy '.repeat(80)}</div>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse('<html><title>Just a moment...</title></html>'))
      .mockResolvedValueOnce(htmlResponse(rescuedListing));
    vi.stubGlobal('fetch', fetchMock);

    const fetchPage = createAplusPageFetcher({
      listingUrl,
      userAgent: 'A++ test browser',
    });

    await expect(fetchPage(listingUrl, 1_000)).resolves.toBe(rescuedListing);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rescues an HTTP 200 detail challenge before parsing the vacancy', async () => {
    const listingUrl = 'https://inrecruiting.intervieweb.it/a2plus/en/career';
    const detailUrl = 'https://inrecruiting.intervieweb.it/a2plus/jobs/role-724674/en/';
    const rescuedDetail = `
      <div id="description__header">
        <h2 id="description__vacancy-title">Rescued A++ vacancy</h2>
        <div id="description__subtitle"><span class="subtitle__informations">Massagno, Switzerland</span></div>
      </div>
    `;
    const fetchMock = vi.fn(async (url: string) => (
      url.startsWith('https://r.jina.ai/')
        ? htmlResponse(rescuedDetail)
        : htmlResponse('<html><title>Just a moment...</title></html>')
    ));
    vi.stubGlobal('fetch', fetchMock);

    const fetchPage = createAplusPageFetcher({
      listingUrl,
      userAgent: 'A++ test browser',
    });

    const detailHtml = await fetchPage(detailUrl, 1_000);

    expect(detailHtml).toBe(rescuedDetail);
    expect(parseAplusJobDetail(detailHtml, detailUrl).title).toBe('Rescued A++ vacancy');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('r.jina.ai/https://inrecruiting.intervieweb.it');
  });
});
