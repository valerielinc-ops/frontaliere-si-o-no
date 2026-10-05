import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({
  ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(),
  politeFetch: io.page,
}));
import { fetchAllC1aHunkelerJobs } from '../scripts/lib/1a-hunkeler-job-parser.mjs';
import { fetchAllAccorJobs } from '../scripts/lib/accor-job-parser.mjs';
import { fetchAllApleonaSchweizAgJobs } from '../scripts/lib/apleona-schweiz-ag-job-parser.mjs';
import { fetchAllArxadaJobs } from '../scripts/lib/arxada-job-parser.mjs';
const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pages = {
  hunkeler: fixture('./fixtures/1a-hunkeler/detail-fenster-monteur.html'),
  accor: fixture('./__fixtures__/accor/detail-rich.html'),
  apleona: fixture('./fixtures/apleona/detail-servicetechniker.html'),
};
const urls = {
  hunkeler: 'https://www.1a-hunkeler.ch/menschen/offene-stellen/detail/fenster-monteur',
  accor: 'https://careers.accor.com/fr/fr/job/receptionniste-in-geneva-switzerland-jid-12345',
  apleona: 'https://recruitingapp-2765.umantis.com/Vacancies/2553/Description/1',
};
function withDate(html: string, raw: unknown, url: string) {
  let found = false;
  const source = html.replace(/(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/gi, (_all, start, body, end) => {
    const node = JSON.parse(body);
    for (const record of node['@graph'] || [node]) if (record['@type'] === 'JobPosting') {
      found = true; record.datePosted = raw; record.dateCreated = '2026-09-27'; record.dateModified = '2026-09-28'; record.validThrough = '2026-09-29';
    }
    return start + JSON.stringify(node) + end;
  });
  if (found) return source;
  return source + `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Servicetechniker Lüftung (m/w/d)', datePosted: raw, dateCreated: '2026-09-27', dateModified: '2026-09-28', validThrough: '2026-09-29', jobLocation: { address: { addressLocality: 'Bischofszell', addressRegion: 'TG', addressCountry: 'CH' } } })}</script>`;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.page.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const cases = [
  ['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'],
  [undefined, ''], ['2026-02-30', ''], ['2026-10-05', ''],
] as const;
for (const key of ['hunkeler', 'accor', 'apleona'] as const) describe(`${key} actual spec pipeline publication`, () => {
  it.each(cases)('preserves only explicit date %s', async (raw, expected) => {
    const detail = withDate(pages[key], raw, urls[key]);
    io.page.mockImplementation(async (url: string) => ({ ok: true, status: 200, url,
      body: url === urls[key] ? detail : `<a href="${urls[key]}">Vacancy</a><span class="attrax-pagination__results-of--2">1</span>` }));
    const jobs = await ({ hunkeler: fetchAllC1aHunkelerJobs, accor: fetchAllAccorJobs, apleona: fetchAllApleonaSchweizAgJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(urls[key]);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
  });
});
describe('Arxada actual Workday discovery and detail', () => {
  it.each(cases)('validates detail publication %s', async (raw, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).endsWith('/jobs')
      ? { total: 1, jobPostings: [{ title: 'Engineer', externalPath: '/job/Visp/Engineer_R1', locationsText: 'CH Visp', postedOn: 'Posted Today' }] }
      : { jobPostingInfo: { title: 'Engineer', location: 'CH Visp', jobDescription: '<p>' + 'Experienced engineering specialists support our Swiss production team and develop reliable processes. '.repeat(10) + '</p>', startDate: raw, createdAt: '2026-09-27', postedOn: 'Posted Today' } })));
    const jobs = await fetchAllArxadaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
