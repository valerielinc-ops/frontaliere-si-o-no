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

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => 'application/json',
      getSetCookie: () => [],
    },
    text: async () => JSON.stringify(body),
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

  it('uses the public InRecruiting AJAX listing when the career route redirects to access', async () => {
    const listingUrl = 'https://inrecruiting.intervieweb.it/a2plus/en/career';
    const accessPage = `
      <html><head><title>Inrecruiting | access</title></head><body>
        <form action="/app.php?CSRFToken=token-123&CSRFHash=hash-456"></form>
      </body></html>`;
    const ajaxData = `
      <div class="row vacancy__render">
        <div class="vacancy__title"><h3><a href="/a2plus/jobs/role-724674/en/">Booking role</a></h3></div>
        <span class="subtitle__informations" title="Location">Massagno SVIZZERA</span>
      </div>`;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (init.method === 'POST') return jsonResponse({ success: true, data: ajaxData });
      return htmlResponse(accessPage, ['intervieweb_session=session-1; Path=/; Secure']);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fetchPage = createAplusPageFetcher({
      listingUrl,
      userAgent: 'A++ test browser',
    });

    await expect(fetchPage(listingUrl, 1_000)).resolves.toBe(ajaxData);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen[1].url).toContain('module=newcareer');
    expect(seen[1].url).toContain('IdAzienda=34990');
    expect(seen[1].url).toContain('CSRFToken=token-123');
    expect((seen[1].init.headers as Record<string, string>).Cookie).toContain('intervieweb_session=session-1');
    expect(new URLSearchParams(String(seen[1].init.body)).get('act1')).toBe('vacancyListCareer');
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
