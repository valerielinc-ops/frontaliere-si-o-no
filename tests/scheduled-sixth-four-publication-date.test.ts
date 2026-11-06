import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ cookies: vi.fn(), json: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtmlWithCookies: io.cookies, fetchJson: io.json }));
import { fetchAllKsaJobs } from '../scripts/lib/ksa-job-parser.mjs';
import { fetchAllKsblJobs } from '../scripts/lib/ksbl-job-parser.mjs';
import { fetchAllKswJobs } from '../scripts/lib/ksw-job-parser.mjs';
import { fetchAllLonzaJobs } from '../scripts/lib/lonza-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.cookies.mockReset(); io.json.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const ksaCard = `<tr class="table-as-list__contentrow1"><td><h3 class="tableaslist_element_1152488"><a href="/Vacancies/5759/Application/CheckLogin/1">Pflegefachperson</a></h3><p class="tableaslist_element_1184115">${prose}</p></td></tr>`;
function ksa(raw: unknown, vacancyId = '5759') {
  io.cookies.mockResolvedValue(ksaCard);
  io.json.mockResolvedValue({ total: 1, jobs: [{ start_date: raw, end_date: '2026-09-28', last_modification_timestamp: '2026-09-27', szas: { sza_apply_link: vacancyId, sza_introduction: prose, sza_starting_date: '2026-09-26' } }] });
}
for (const key of ['ksa', 'ksbl', 'ksw', 'lonza'] as const) describe(`${key} actual producer publication`, () => {
  it.each(cases)('validates %s', async (raw, expected) => {
    const detail = `<div class="introduction">${prose}</div><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Pflegefachperson', description: prose, datePosted: raw, validThrough: '2026-09-28', dateCreated: '2026-09-27' })}</script>`;
    if (key === 'ksa') ksa(raw);
    if (key === 'ksbl') vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('/detail/job/') ? detail : '<div class="col-12 col-sm-6 col-lg-4 mb-gap mt-gap"><a href="https://karriere.ksbl.ch/de/offene-stellen/jobs/detail/job/pflegefachperson/12345678-1234-1234-1234-123456789012"><h3 class="card-title">Pflegefachperson</h3></a></div></div></div>')));
    if (key === 'ksw') vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('/job/details/') ? detail : '<div class="job"><a href="job/details/123"><div class="jobtitle">Pflegefachperson</div></a></div>')));
    if (key === 'lonza') vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).endsWith('/jobs')
      ? { total: 1, jobPostings: [{ title: 'Fachperson Engineering', externalPath: '/job/Visp/Fachperson_R123', postedOn: 'Posted Today' }] }
      : { jobPostingInfo: { title: 'Fachperson Engineering', location: 'Visp', country: { descriptor: 'Switzerland', alpha2Code: 'CH' }, jobDescription: prose, startDate: raw } })));
    const jobs = await ({ ksa: fetchAllKsaJobs, ksbl: fetchAllKsblJobs, ksw: fetchAllKswJobs, lonza: fetchAllLonzaJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
it('KSA never borrows the date of a different Umantis vacancy', async () => {
  ksa('2026-09-29T10:00:00Z', '9999');
  const jobs = await fetchAllKsaJobs();
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
});
it('KSA preserves a usable listing when enrichment fails, without a clock date', async () => {
  ksa(undefined); io.json.mockRejectedValue(new Error('HTTP failure'));
  const jobs = await fetchAllKsaJobs();
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  expect(jobs[0].description).toContain('Unser Team');
});
