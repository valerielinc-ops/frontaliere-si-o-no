import { afterEach, describe, expect, it, vi } from 'vitest';
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

function response(body: string) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  };
}

describe('Bachtelen job parser', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('trusts only Bachtelen domains', () => {
    expect(isTrustedDomain('https://www.bachtelen.ch/stelle/test/')).toBe(true);
    expect(isTrustedDomain('https://jobs.example.com/stelle/test/')).toBe(false);
  });
});
