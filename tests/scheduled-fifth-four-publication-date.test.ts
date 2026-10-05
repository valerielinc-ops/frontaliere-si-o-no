import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ html: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html }));
import { fetchAllHuberSuhnerJobs } from '../scripts/lib/huber-suhner-job-parser.mjs';
import { fetchAllHuntsmanJobs } from '../scripts/lib/huntsman-job-parser.mjs';
import { fetchAllIntegraBiosciencesJobs } from '../scripts/lib/integra-biosciences-job-parser.mjs';
import { fetchAllKantonSolothurnJobs } from '../scripts/lib/kanton-solothurn-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.html.mockReset(); vi.stubEnv('JOBS_CRAWLER_DELAY_MS', '1'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
const integraUrl = 'https://jobs.integra-biosciences.com/Vacancies/326/Description/2?lang=eng';
const listing = (onlineSince?: unknown) => `<script type="application/json" data-drupal-selector="drupal-settings-json">${JSON.stringify({ jobsAllData: [{ title: 'Fachperson Engineering', country: 'Switzerland', publicationUrl: integraUrl, onlineSince }] })}</script>`;
const ld = (datePosted: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Fachperson Engineering', description: prose, datePosted, validThrough: '2026-09-28', dateCreated: '2026-09-27', jobLocation: { address: { addressLocality: 'Solothurn', addressCountry: 'CH' } } })}</script>`;
for (const key of ['huber', 'huntsman', 'integra', 'solothurn'] as const) describe(`${key} publication through actual producer`, () => {
  it.each(cases)('validates source %s', async (raw, expected) => {
    const swiss = raw === undefined ? '' : raw === cases[0][0] ? '29.09.2026' : raw.split('-').reverse().join('.');
    if (key === 'huber') io.html.mockImplementation(async (url: string) => url.includes('/Description/') ? `<h2>Ihre Aufgaben</h2><p>${prose}</p>` : `<tr class="tableaslist_contentrow1"><td><a href="/Vacancies/123/Description/1">Fachperson Engineering</a><span class="tableaslist_element_1152495">&nbsp;|&nbsp; Herisau (AR)</span>Online since: ${swiss}</td></tr>`);
    if (key === 'huntsman') vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).endsWith('/jobs')
      ? { total: 1, jobPostings: [{ title: 'Fachperson Engineering', externalPath: '/job/Monthey/Fachperson_R123', postedOn: 'Posted Today' }] }
      : { jobPostingInfo: { title: 'Fachperson Engineering', location: 'Monthey', country: { descriptor: 'Switzerland', alpha2Code: 'CH' }, jobDescription: prose, startDate: raw } })));
    if (key === 'solothurn') io.html.mockImplementation(async (url: string) => url.includes('/offene-stellen/') ? ld(raw) : url.includes('offset=') ? '' : '<a class="job" href="https://jobs.so.ch/offene-stellen/fachperson/123">Fachperson Engineering</a>');
    const jobs = key === 'integra'
      ? await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => listing(), fetchDetail: async () => ld(raw) })
      : await ({ huber: fetchAllHuberSuhnerJobs, huntsman: fetchAllHuntsmanJobs, solothurn: fetchAllKantonSolothurnJobs })[key]();
    expect(jobs).toHaveLength(1);
    const date = key === 'huber' && expected ? '2026-09-29' : expected;
    expect(jobs[0]).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: date ? 'reported' : 'unknown' });
  });
});
for (const raw of ['29.09.20260', '29.09.2026junk']) it(`Huber rejects malformed Online since ${raw}`, async () => {
  io.html.mockResolvedValue(`<tr class="tableaslist_contentrow1"><td><a href="/Vacancies/123/Description/1">Fachperson Engineering</a><span class="tableaslist_element_1152495">&nbsp;|&nbsp; Herisau (AR)</span>Online since: ${raw}</td></tr>`);
  const jobs = await fetchAllHuberSuhnerJobs();
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
});
it.each([undefined, true, {}, [], 'junk', 1e100].map(raw => ({ raw })))('Integra rejects invalid epoch $raw without throwing', async ({ raw }) => {
  const jobs = await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => listing(raw), fetchDetail: async () => ld(undefined) });
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
});
it('Integra preserves full listing epoch when detail publication is invalid', async () => {
  const jobs = await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => listing(1790687700), fetchDetail: async () => ld('invalid') });
  const date = new Date(1790687700 * 1000).toISOString();
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
});
