import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ html: vi.fn(), json: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html, fetchJson: io.json }));
import { fetchAllSwissLifeJobs } from '../scripts/lib/swiss-life-job-parser.mjs';
import { fetchAllSwisslogJobs } from '../scripts/lib/swisslog-job-parser.mjs';
import { fetchAllSygnumJobs } from '../scripts/lib/sygnum-job-parser.mjs';
import { fetchAllTschuggenJobs } from '../scripts/lib/tschuggen-job-parser.mjs';
import { fetchAllUbpJobs } from '../scripts/lib/ubp-job-parser.mjs';
import { fetchAllVaudoiseJobs } from '../scripts/lib/vaudoise-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.html.mockReset(); io.json.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function oracle(raw: unknown, secondary: unknown = raw) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).includes('RequisitionDetails/')
    ? { ExternalPostedStartDate: secondary, ExternalDescriptionStr: prose }
    : { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '123', Title: 'Financial specialist', PrimaryLocation: 'Geneva', PostedDate: raw }] }] })));
}
for (const key of ['swisslife', 'swisslog', 'sygnum', 'tschuggen', 'ubp', 'vaudoise'] as const) describe(`${key} actual publication source`, () => {
  it.each(cases)('validates source %s', async (raw, expected) => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Fachperson Engineering', description: prose, datePosted: raw, dateCreated: '2026-09-28', jobLocation: { address: { addressLocality: 'Zürich', addressCountry: 'CH' } } })}</script>`;
    if (key === 'swisslife') vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).endsWith('/jobs')
      ? { total: 1, jobPostings: [{ title: 'Fachperson Engineering', externalPath: '/job/Zuerich/Fachperson_R123', locationsText: 'Zürich', postedOn: 'Posted Today' }] }
      : { jobPostingInfo: { title: 'Fachperson Engineering', location: 'Zürich', country: { descriptor: 'Switzerland', alpha2Code: 'CH' }, jobDescription: prose, startDate: raw } })));
    if (key === 'swisslog') { io.json.mockResolvedValue({ items: [{ headline: 'Fachperson Engineering', href: 'https://www.swisslog.com/jobs/fachperson-123', facetsTop: ['Zürich, Switzerland'] }] }); io.html.mockResolvedValue(ld.replace('>', '>[').replace('</script>', ']</script>')); }
    if (key === 'sygnum') vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('vacancyNo=') ? `${ld}<th class="labelCol"><label>Description</label></th><td class="data2Col">${prose}</td>` : '<a href="/detail?vacancyNo=VN123">Fachperson Engineering</a>')));
    if (key === 'tschuggen') vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('/Vacancies/') ? `${ld}<h3>Ihre Aufgaben</h3><div class="padding">${prose}</div>` : '<tr class="tableaslist_contentrow1"><td><a href="/Vacancies/123/Description/1">Fachperson Engineering</a><span class="tableaslist_element_1152495">Arosa</span><br></td></tr>')));
    if (key === 'ubp') oracle(raw);
    const close = vi.fn(async () => {});
    const runtime = { createBrowser: async () => ({}), createPoliteContext: async () => ({}), fetchWithRateLimit: async () => ({ waitForSelector: async () => {}, $$eval: async () => [{ id: '123', title: 'Financial specialist', url: 'https://vaudoise.softgarden.io/job/123/fachperson', location: 'Lausanne', postedDate: '2026-09-27' }] }), closeAll: close };
    const jobs = key === 'vaudoise' ? await fetchAllVaudoiseJobs({ _runtime: async () => runtime, _detailFetcher: async () => ld }) : await ({ swisslife: fetchAllSwissLifeJobs, swisslog: fetchAllSwisslogJobs, sygnum: fetchAllSygnumJobs, tschuggen: fetchAllTschuggenJobs, ubp: fetchAllUbpJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    if (key === 'vaudoise') expect(close).toHaveBeenCalledOnce();
  });
});
it('UBP validates secondary publication when primary is invalid', async () => {
  oracle('invalid', '2026-09-29T10:00:00Z');
  const jobs = await fetchAllUbpJobs();
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '2026-09-29T10:00:00Z', postedDate: '2026-09-29T10:00:00Z', postingDateSource: 'reported' });
});
