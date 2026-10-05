import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async (original) => ({
  ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml,
}));
import { fetchMcdoJobs } from '../scripts/lib/mcdonalds-job-parser.mjs';
import { fetchAllNewYorkerJobs } from '../scripts/lib/new-yorker-job-parser.mjs';
import { fetchAllNovelisJobs } from '../scripts/lib/novelis-job-parser.mjs';
import { fetchAllOmegaJobs } from '../scripts/lib/omega-job-parser.mjs';

const TITLE = 'Service Engineer';
const DATE = '2020-06-15T10:11:12.123+02:00';
const UNKNOWN = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const reported = (date = DATE) => ({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
const urls = {
  mcdo: 'https://jobs.mcdonalds.ch/fr-ch/service-engineer/job/P8-test',
  newyorker: 'https://jobs.newyorker.de/karriere-schweiz/service-engineer-de-j123.html',
  novelis: 'https://jobs-novelis.icims.com/jobs/123/service-engineer/job',
  omega: 'https://www.swatchgroup.com/en/job/123',
};
type Family = keyof typeof urls;
type Posting = Record<string, unknown>;
function posting(family: Family, override: Posting = {}): Posting {
  return { '@type': 'JobPosting', title: TITLE, url: urls[family], datePosted: DATE,
    description: '<p>Official source responsibilities for the Swiss service team.</p>',
    jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH', postalCode: '6900' } },
    ...override };
}
function detail(family: Family, records: Posting[]) {
  const ld = records.map((record) => `<script type="application/ld+json">${JSON.stringify(record)}</script>`).join('');
  if (family === 'novelis') return `${ld}<div class="iCIMS_JobContent"><p>Official source responsibilities.</p></div>`;
  if (family === 'omega') return `${ld}<img src="brands-logos/omega.png"><h1><span class="field f-n-title">${TITLE}</span></h1><div id="jl"><p>Location</p>Lugano, Switzerland</div>`;
  return ld;
}
async function crawl(family: Family, records: Posting[], { locationless = false, detailHeading = TITLE } = {}) {
  const html = detail(family, records).replace(`<span class="field f-n-title">${TITLE}</span>`, `<span class="field f-n-title">${detailHeading}</span>`);
  if (family === 'mcdo') {
    const entry = { title: TITLE, reference: 'P8-test', originalURL: 'fr-ch/service-engineer/job/P8-test',
      locations: [{ city: 'Lugano', stateAbbr: 'TI', countryAbbr: 'CH' }] };
    const list = `<script>window.__PRELOAD_STATE__ = ${JSON.stringify({ jobSearch: { jobs: [entry], totalJob: 1 } })};</script>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('/emplois-restauration') ? list : html)));
    return fetchMcdoJobs({ detailConcurrency: 1 });
  }
  if (family === 'newyorker') {
    const list = `<tr class="alternative_1"><td class="real_table_col1"><a href="${urls.newyorker}?sid=abc">${TITLE}</a></td><td class="real_table_col2">Lugano</td><td class="real_table_col3">Service</td></tr>`;
    fetchHtml.mockImplementation(async (url: string) => url.includes('stellenangebote.html') ? list : html);
    return fetchAllNewYorkerJobs();
  }
  if (family === 'novelis') {
    const list = `<li class="iCIMS_JobCardItem"><div class="header left"><span class="sr-only field-label">Job Locations</span><span>${locationless ? 'DE-Berlin' : 'CH-TI-Lugano'}</span></div><a class="iCIMS_Anchor" href="${urls.novelis}"><h3>${TITLE}</h3></a></li>`;
    fetchHtml.mockImplementation(async (url: string) => url.includes('/jobs/search') ? list : html);
    return fetchAllNovelisJobs();
  }
  const list = `<div class="card h-100"><img src="brands-logos/omega.png"><h4 class="card-title"><a href="/en/job/123">${TITLE}</a></h4><p class="card__text">Swiss source role</p></div>`;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('job-finder')
    ? (new URL(String(url)).searchParams.get('page') === '0' ? list : '<html></html>') : html)));
  return fetchAllOmegaJobs();
}
beforeEach(() => { fetchHtml.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
for (const family of Object.keys(urls) as Family[]) {
  describe(`${family}: source detail → emitted job`, () => {
    it.each([
      { label: 'full offset', raw: DATE, expected: reported() },
      { label: 'missing', raw: undefined, expected: UNKNOWN },
      { label: 'invalid calendar', raw: '2020-02-30T10:11:12+02:00', expected: UNKNOWN },
      { label: 'future', raw: '2999-01-01T00:00:00Z', expected: UNKNOWN },
    ])('$label publication', async ({ raw, expected }) => {
      const jobs = await crawl(family, [posting(family, { datePosted: raw, validThrough: '2020-01-01', dateModified: '2020-01-01' })]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ ...expected, url: urls[family], title: TITLE });
    });
    it('rejects another vacancy even when it supplies a valid date', async () => {
      const jobs = await crawl(family, [posting(family, { url: `${urls[family]}-other` })]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(UNKNOWN);
    });
    it('rejects conflicting sameAs identity', async () => {
      const jobs = await crawl(family, [posting(family, { sameAs: `${urls[family]}-other` })]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(UNKNOWN);
    });
  });
}
it('McDonald preserves publication through the missing-detail-location branch', async () => {
  const jobs = await crawl('mcdo', [posting('mcdo', { jobLocation: undefined })]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...reported(), location: 'Lugano', canton: 'TI' });
});
it('McDonald still excludes an explicitly foreign detail', async () => {
  const jobs = await crawl('mcdo', [posting('mcdo', { jobLocation: { address: { addressLocality: 'Como', addressRegion: 'CO', addressCountry: 'IT' } } })]);
  expect(jobs).toEqual([]);
});
it('Novelis does not turn a foreign-only listing into a Swiss job', async () => {
  expect(await crawl('novelis', [posting('novelis')], { locationless: true })).toEqual([]);
});
it('New Yorker removes the session URL while preserving evidence', async () => {
  const jobs = await crawl('newyorker', [posting('newyorker')]);
  expect(jobs[0]).toMatchObject({ ...reported(), url: urls.newyorker });
  expect(fetchHtml).toHaveBeenCalledWith(urls.newyorker, expect.any(Object));
});

it('New Yorker does not assign a second posting date to the first emitted title', async () => {
  const jobs = await crawl('newyorker', [
    posting('newyorker', { title: 'Another Vacancy', datePosted: undefined }),
    posting('newyorker'),
  ]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Another Vacancy' });
});
it('Omega does not assign a listing-matched date to a different emitted heading', async () => {
  const jobs = await crawl('omega', [posting('omega')], { detailHeading: 'Another Vacancy' });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: 'Another Vacancy' });
});
it('Omega propagates a later listing-page failure', async () => {
  const list = `<div class="card h-100"><img src="brands-logos/omega.png"><h4 class="card-title"><a href="/en/job/123">${TITLE}</a></h4><p class="card__text">Swiss source role</p></div>`;
  const failure = new Error('page 2 down');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const value = String(url);
    if (!value.includes('job-finder')) return new Response(detail('omega', [posting('omega')]));
    if (new URL(value).searchParams.get('page') === '0') return new Response(list);
    throw failure;
  }));
  await expect(fetchAllOmegaJobs()).rejects.toBe(failure);
});
