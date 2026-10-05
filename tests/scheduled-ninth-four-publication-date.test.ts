import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({ ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(), politeFetch: io.page }));
import { fetchAllSchweizerhofFlimsJobs } from '../scripts/lib/schweizerhof-flims-job-parser.mjs';
import { fetchAllSeeSpitalJobs } from '../scripts/lib/see-spital-job-parser.mjs';
import { fetchAllSiegfriedJobs } from '../scripts/lib/siegfried-job-parser.mjs';
import { fetchAllSpitalMaennedorfJobs } from '../scripts/lib/spital-maennedorf-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.page.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const card = `<tr class="table-as-list__contentrow1"><td><h3 class="tableaslist_element_1152488"><a href="/Vacancies/123/Description/1">Pflegefachperson</a></h3><p class="tableaslist_element_1184115">${prose}</p></td></tr>`;
for (const key of ['schweizerhof', 'see', 'siegfried', 'maennedorf'] as const) describe(`${key} actual source publication`, () => {
  it.each(cases)('validates own source %s', async (raw, expected) => {
    const url = 'https://romantikhotels.hcm4all.de/list/chef-123';
    const detail = `<h3>Ihre Aufgaben</h3><div class="padding">${prose}</div><h2 id="expander-1">Ihre Aufgaben</h2><div id="expandable-1">${prose}</div><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Chef de Partie Schweizerhof Flims', description: prose, datePosted: raw, validThrough: '2026-09-28', jobLocation: { address: { addressLocality: 'Flims', addressCountry: 'CH' } } })}</script>`;
    io.page.mockImplementation(async (requested: string) => ({ ok: true, status: 200, url: requested, body: requested === url ? detail : `<a href="${url}">Chef de Partie Schweizerhof Flims</a>` }));
    vi.stubGlobal('fetch', vi.fn(async (requested: string) => {
      if (key === 'siegfried') return Response.json(String(requested).endsWith('/jobs')
        ? { total: 1, jobPostings: [{ title: 'Fachperson Engineering', externalPath: '/job/Zofingen/Fachperson_R123', postedOn: 'Posted Today' }] }
        : { jobPostingInfo: { title: 'Fachperson Engineering', location: 'Zofingen', country: { descriptor: 'Switzerland', alpha2Code: 'CH' }, jobDescription: prose, startDate: raw } });
      return new Response(String(requested).includes('/Vacancies/') ? detail : card);
    }));
    const jobs = await ({ schweizerhof: fetchAllSchweizerhofFlimsJobs, see: fetchAllSeeSpitalJobs, siegfried: fetchAllSiegfriedJobs, maennedorf: fetchAllSpitalMaennedorfJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
for (const [key, producer] of [['see', fetchAllSeeSpitalJobs], ['maennedorf', fetchAllSpitalMaennedorfJobs]] as const) it(`${key} preserves dead-detail quarantine`, async () => {
  vi.stubGlobal('fetch', vi.fn(async (requested: string) => String(requested).includes('/Vacancies/')
    ? new Response('', { status: 302, headers: { location: 'https://example.com/migrated/' } }) : new Response(card)));
  expect(await producer()).toHaveLength(0);
});
