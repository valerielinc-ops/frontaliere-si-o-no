import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ html: vi.fn(), json: vi.fn(), page: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html, fetchJson: io.json }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({ ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(), politeFetch: io.page }));
import { fetchAllEtatDeVaudJobs } from '../scripts/lib/etat-de-vaud-job-parser.mjs';
import { fetchAllEteJobs } from '../scripts/lib/ete-job-parser.mjs';
import { fetchAllFielmannJobs } from '../scripts/lib/fielmann-job-parser.mjs';
import { fetchAllFranklinUniversityJobs } from '../scripts/lib/franklin-university-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.html.mockReset(); io.json.mockReset(); io.page.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function oracle(raw: unknown, secondary: unknown = raw) {
  io.json.mockImplementation(async (url: string) => String(url).includes('RequisitionDetails?')
    ? { items: [{ ExternalPostedStartDate: secondary, ExternalDescriptionStr: prose, PrimaryLocation: 'Lausanne' }] }
    : { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '123', Title: 'Financial specialist', PrimaryLocation: 'Lausanne', PostedDate: raw }] }] });
}
for (const key of ['vaud', 'ete', 'fielmann', 'franklin'] as const) describe(`${key} real publication pipeline`, () => {
  it.each(cases)('handles source %s without clock', async (raw, expected) => {
    if (key === 'vaud') oracle(raw);
    if (key === 'ete') {
      const url = 'https://www.ete.ch/jobs/fachperson-engineering/';
      const detail = `<section class="job_description"><h1>Fachperson Engineering</h1><p>${prose}</p></section><section class="data-sheet"><dt>Standort</dt><dd>St. Gallen</dd></section><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Fachperson Engineering', description: prose, datePosted: raw, jobLocation: { address: { addressLocality: 'St. Gallen', addressCountry: 'CH' } } })}</script>`;
      io.page.mockImplementation(async (requested: string) => ({ ok: true, status: 200, url: requested, body: requested === url ? detail : `<a href="${url}">Fachperson Engineering</a>` }));
    }
    if (key === 'fielmann') vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).endsWith('/jobs')
      ? { total: 1, jobPostings: [{ title: 'Fachperson Engineering', externalPath: '/job/Lugano/Fachperson_R123', postedOn: 'Posted Today', bulletFields: ['R123'] }] }
      : { jobPostingInfo: { title: 'Fachperson Engineering', location: 'Lugano', jobDescription: prose, startDate: raw } })));
    // A site-level date is unrelated to this Drupal vacancy accordion.
    if (key === 'franklin') io.html.mockResolvedValue(`<time datetime="${raw || ''}"></time><div class="paragraph--type-single-accordion" id="para_4660"><h3 class="fus_para_accordion_title">Professor of Economics</h3><div class="fus_para_accordion_text">Location: Lugano. ${prose}</div></div>`);
    const jobs = await ({ vaud: fetchAllEtatDeVaudJobs, ete: fetchAllEteJobs, fielmann: fetchAllFielmannJobs, franklin: fetchAllFranklinUniversityJobs })[key]();
    expect(jobs).toHaveLength(1);
    const date = key === 'franklin' ? '' : expected;
    expect(jobs[0]).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: date ? 'reported' : 'unknown' });
  });
});
it('Vaud validates secondary publication independently of invalid primary', async () => {
  oracle('invalid', '2026-09-29T10:00:00Z');
  const jobs = await fetchAllEtatDeVaudJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: '2026-09-29T10:00:00Z', postedDate: '2026-09-29T10:00:00Z', postingDateSource: 'reported' });
});
