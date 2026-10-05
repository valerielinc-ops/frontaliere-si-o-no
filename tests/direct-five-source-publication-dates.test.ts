import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAbraxasJobs } from '../scripts/lib/abraxas-job-parser.mjs';
import { fetchAllAppleRetailSwitzerlandJobs } from '../scripts/lib/apple-retail-switzerland-job-parser.mjs';
import { fetchAllBachtelenJobs } from '../scripts/lib/bachtelen-job-parser.mjs';
import { fetchAllBeekeeperJobs } from '../scripts/lib/beekeeper-job-parser.mjs';
import { fetchAllBitfinexJobs } from '../scripts/lib/bitfinex-job-parser.mjs';

const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${day}T23:30:00.123-03:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const title = 'Software Engineer';
const description = 'You will work with our engineering team to design and maintain reliable services for customers. Your responsibilities include reviewing requirements, developing new features, testing changes and documenting operational procedures. We provide a structured introduction, continuing professional development and an inclusive working environment. Relevant experience, communication skills and a collaborative approach are required. Join our team and help improve the quality of our products through careful technical work.';
const companies = [
  { key: 'abraxas', fetchJobs: fetchAllAbraxasJobs },
  { key: 'apple-retail-switzerland', fetchJobs: fetchAllAppleRetailSwitzerlandJobs },
  { key: 'bachtelen', fetchJobs: fetchAllBachtelenJobs },
  { key: 'beekeeper', fetchJobs: fetchAllBeekeeperJobs },
  { key: 'bitfinex', fetchJobs: fetchAllBitfinexJobs },
];
function bitfinexOffer(raw: string | undefined, slug = 'software-engineer') {
  return { id: slug, title, slug, description, published_at: raw, created_at: day, updated_at: day,
    employment_type_code: 'fulltime', locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland' }] };
}
function stubSource(key: string, raw: string | undefined, overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    let payload: unknown;
    if (key === 'abraxas') {
      const detailUrl = 'https://www.abraxas.ch/de/karriere/software-engineer';
      const listing = `<li class="job-list__list-item"><a href="${detailUrl}" class="job-list__job"><div class="job-list__job-title">${title}</div><div class="job-list__job-location">Zürich</div></a></li>`;
      const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, datePosted: raw, dateModified: day, jobStartDate: day })}</script><h1 class="header__title">${title}<span class="subtitle">Zürich</span></h1><div class="rich-text-field"><p>${description}</p></div>`;
      return new Response(url === detailUrl ? detail : listing, { status: 200 });
    }
    if (key === 'apple-retail-switzerland') {
      if (url.endsWith('/CSRFToken')) return new Response('{}', { status: 200, headers: { 'x-apple-csrf-token': 'fixture', 'set-cookie': 'a=b; Path=/' } });
      if (url.endsWith('/api/v1/search')) payload = { res: { totalRecords: 1, searchResults: [{ positionId: '200600001', postingTitle: title,
        transformedPostingTitle: 'software-engineer', jobSummary: description, locations: [{ name: 'Zurich' }],
        postDateInGMT: raw, modifiedDate: day, team: { teamID: 'teamsAndSubTeams-APPST' } }] } };
      else return new Response('<html></html>', { status: 200 });
    } else if (key === 'bachtelen') {
      payload = [{ id: 123, title: { rendered: title }, link: 'https://www.bachtelen.ch/job/software-engineer/',
        content: { rendered: `<p>${description}</p>` }, meta: { _job_location: 'Grenchen', _filled: 0 },
        date_gmt: raw, modified: day, modified_gmt: day, ...overrides }];
    } else if (key === 'beekeeper') {
      payload = { items: [{ id: '123', title, url: 'https://jobs.lumapps.com/software-engineer', content_html: `<p>${description}</p>`,
        date_published: raw, date_modified: day, _jobposting: { jobLocation: [{ address: { addressCountry: 'CH', addressLocality: 'Zürich' } }] } }] };
    } else if (key === 'bitfinex') payload = { offers: [bitfinexOffer(raw)] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const company of companies) {
  describe(`${company.key} explicit publication provenance`, () => {
    it.each([
      ['timestamp', timestamp, timestamp], ['missing', undefined, ''],
      ['invalid', '2026-02-30', ''], ['future', future, ''],
    ] as const)('%s through actual producer', async (_label, raw, expected) => {
      stubSource(company.key, raw);
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ companyKey: company.key, title, datePosted: expected,
        postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
      expect(jobs[0].description).toContain('engineering team');
      expect(jobs[0].url).toBeTruthy();
      expect(jobs[0].canton).toBeTruthy();
      expect(jobs[0].crawledAt).toBeTruthy();
    });
  });
}
it.each(companies.filter(({ key }) => ['bachtelen', 'apple-retail-switzerland'].includes(key)))('$key uses the explicit GMT field timezone', async ({ key, fetchJobs }) => {
  stubSource(key, `${day}T12:30:00`);
  const [job] = await fetchJobs();
  expect(job).toMatchObject({ datePosted: `${day}T12:30:00Z`, postedDate: `${day}T12:30:00Z`, postingDateSource: 'reported' });
});
it('Bachtelen validates fallback publication independently and ignores unzoned local time', async () => {
  stubSource('bachtelen', 'invalid', { date: timestamp });
  expect((await fetchAllBachtelenJobs())[0].datePosted).toBe(timestamp);
  stubSource('bachtelen', undefined, { date: `${day}T12:30:00` });
  expect((await fetchAllBachtelenJobs())[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
});
it('Bitfinex dedup compares instants and retains the selected complete job tuple', async () => {
  const earlier = `${day}T23:00:00+05:00`;
  const later = `${day}T20:00:00Z`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ offers: [
    bitfinexOffer(earlier, 'earlier'), bitfinexOffer(later, 'later'),
  ] }), { status: 200 })));
  const jobs = await fetchAllBitfinexJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: later, postedDate: later, postingDateSource: 'reported' });
  expect(jobs[0].url).toContain('later');
});
