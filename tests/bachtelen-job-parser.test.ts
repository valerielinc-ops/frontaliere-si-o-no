import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchViaJinaWithRetry } = vi.hoisted(() => ({ fetchViaJinaWithRetry: vi.fn() }));
vi.mock('../scripts/lib/jina-proxy.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchViaJinaWithRetry };
});

import {
  BACHTELEN_COMPANY_NAME,
  fetchAllBachtelenJobs,
  isTrustedDomain,
  parseBachtelenListingPage,
} from '../scripts/lib/bachtelen-job-parser.mjs';

const CAREER_PAGE = `
  <nav><a href="/kontakt">Kontakt</a></nav>
  <div class="elementor-widget-container job-details">
    <div class="text_20">70 %</div>
    <div class="text_20">Hägendorf</div>
    <a href="https://www.bachtelen.ch/stelle/sozialpaedagogik/">Weitere Infos</a>
  </div>
  <div class="elementor-widget-container job-details">
    <div class="text_20">60-100 %</div>
    <div class="text_20">Grenchen</div>
    <a href="/stelle/heilpaedagogik/">Weitere Infos</a>
  </div>
`;

function response(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

describe('Bachtelen job parser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchViaJinaWithRetry.mockReset();
  });

  it('extracts locations from the job cards and ignores unrelated links', () => {
    const locations = parseBachtelenListingPage(CAREER_PAGE);

    expect([...locations.entries()]).toEqual([
      ['https://www.bachtelen.ch/stelle/sozialpaedagogik/', 'Hägendorf'],
      ['https://www.bachtelen.ch/stelle/heilpaedagogik/', 'Grenchen'],
    ]);
  });

  it('uses the current stelle REST endpoint and keeps card locations', async () => {
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('/wp-json/wp/v2/stelle?')) {
        return response(JSON.stringify([
          {
            id: 12,
            date: '2026-10-15T10:00:00',
            date_gmt: '2026-10-15T08:00:00',
            link: 'https://www.bachtelen.ch/stelle/sozialpaedagogik/',
            title: { rendered: 'Sozialpädagog:in FH / HF 70-80%' },
            content: {
              rendered: '<p>Begleitung von Kindern und Jugendlichen im Huus am Schärme in Hägendorf.</p>',
            },
            meta: {},
          },
        ]));
      }
      if (url === 'https://www.bachtelen.ch/arbeiten-bei-uns/') {
        return response(CAREER_PAGE);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllBachtelenJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      company: BACHTELEN_COMPANY_NAME,
      title: 'Sozialpädagog:in FH / HF 70-80%',
      location: 'Hägendorf',
      canton: 'SO',
      source: 'Bachtelen Dedicated Parser (WP REST stelle)',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/wp-json/wp/v2/stelle?per_page=50&status=publish'),
      expect.any(Object),
    );
  });

  it('rescues a direct HTTP 403 through the Jina clean-IP proxy as raw JSON', async () => {
    const listing = [{
      id: 12,
      date: '2026-10-15T10:00:00',
      date_gmt: '2026-10-15T08:00:00',
      link: 'https://www.bachtelen.ch/stelle/sozialpaedagogik/',
      title: { rendered: 'Sozialpädagog:in FH / HF 70-80%' },
      content: {
        rendered: `<p>${'Begleitung von Kindern und Jugendlichen im Huus am Schärme in Hägendorf. '.repeat(5)}</p>`,
      },
      meta: {},
    }];
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('/wp-json/wp/v2/stelle?')) return response('', 403);
      if (url === 'https://www.bachtelen.ch/arbeiten-bei-uns/') return response(CAREER_PAGE);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    fetchViaJinaWithRetry.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(listing),
    });

    const jobs = await fetchAllBachtelenJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Sozialpädagog:in FH / HF 70-80%', location: 'Hägendorf' });
    expect(fetchViaJinaWithRetry).toHaveBeenCalledOnce();
    expect(fetchViaJinaWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/wp-json/wp/v2/stelle?per_page=50&status=publish'),
      expect.objectContaining({ format: 'text', validateBody: expect.any(Function) }),
    );
  });

  it('accepts an authoritative empty JSON array from the Jina raw-text response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('/wp-json/wp/v2/stelle?')) return response('', 403);
      if (url === 'https://www.bachtelen.ch/arbeiten-bei-uns/') return response(CAREER_PAGE);
      throw new Error(`unexpected fetch: ${url}`);
    }));
    fetchViaJinaWithRetry.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '[]',
    });

    await expect(fetchAllBachtelenJobs()).resolves.toEqual([]);
    const options = fetchViaJinaWithRetry.mock.calls[0]?.[1];
    expect(options?.validateBody('[]')).toBeNull();
    expect(options?.validateBody(JSON.stringify({ code: 'rest_forbidden' }))).toMatch(/not an array/);
  });

  it.each([
    ['a challenge body', 'Just a moment...'],
    ['an invalid JSON body', `<html><body>${'not json '.repeat(30)}</body></html>`],
    ['a JSON error envelope', JSON.stringify({ code: 'rest_forbidden' })],
  ])('rethrows the original HTTP 403 when Jina returns %s', async (_label, proxyBody) => {
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      if (String(rawUrl).includes('/wp-json/wp/v2/stelle?')) return response('', 403);
      throw new Error(`unexpected fetch: ${rawUrl}`);
    }));
    fetchViaJinaWithRetry.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => proxyBody,
    });

    await expect(fetchAllBachtelenJobs()).rejects.toThrow(/Failed to fetch Bachtelen WP REST stelle: HTTP 403/);
    expect(fetchViaJinaWithRetry).toHaveBeenCalledOnce();
  });

  it('trusts only Bachtelen domains', () => {
    expect(isTrustedDomain('https://www.bachtelen.ch/stelle/test/')).toBe(true);
    expect(isTrustedDomain('https://jobs.example.com/stelle/test/')).toBe(false);
  });
});
