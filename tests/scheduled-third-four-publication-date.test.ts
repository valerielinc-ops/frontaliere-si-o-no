import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ html: vi.fn(), json: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html, fetchJson: io.json }));
import { fetchAllCssVersicherungJobs } from '../scripts/lib/css-versicherung-job-parser.mjs';
import { fetchAllDufercoJobs } from '../scripts/lib/duferco-job-parser.mjs';
import { fetchAllEdmondDeRothschildJobs } from '../scripts/lib/edmond-de-rothschild-job-parser.mjs';
import { fetchAllElettra1938Jobs } from '../scripts/lib/elettra-1938-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.html.mockReset(); io.json.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function oracle(raw: unknown, secondary: unknown = raw) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(String(url).includes('RequisitionDetails/')
    ? { ExternalPostedStartDate: secondary, ExternalDescriptionStr: prose }
    : { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '123', Title: 'Financial specialist', PrimaryLocationCountry: 'CH', PrimaryLocation: 'Geneva', PostedDate: raw }] }] })));
}
for (const key of ['css', 'duferco', 'edmond', 'elettra'] as const) describe(`${key} real publication pipeline`, () => {
  it.each(cases)('handles source %s without clock', async (raw, expected) => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Fachperson Engineering', description: prose, datePosted: raw, validThrough: '2026-09-28', dateCreated: '2026-09-27', jobLocation: { address: { addressLocality: 'Luzern', addressCountry: 'CH' } } })}</script>`;
    if (key === 'css') io.html.mockImplementation(async (url: string) => url.includes('/offene-stellen/') ? ld : url.includes('offset=0&') ? '<a class="job-title" href="https://jobs.css.ch/offene-stellen/engineer/123">Engineer</a>' : '');
    if (key === 'elettra') io.html.mockImplementation(async (url: string) => url.includes('/fiammcomponents/jobs/') ? ld : '<div class="vacancy__render"><div class="vacancy__title"><h3><a href="/fiammcomponents/jobs/engineer-123/it/">Fachperson Engineering</a></h3></div><span class="subtitle__informations" title="Sede">Stabio, Svizzera</span><span class="subtitle__informations" title="Azienda">Elettra 1938</span><div class="vacancy__description">Source teaser</div></div>');
    if (key === 'duferco') io.json.mockResolvedValue([{ id: '123', title: 'Fachperson Engineering', location: 'Lugano, Switzerland', description: prose, created_at: raw, status: 'active', visibility: 'public_main' }]);
    if (key === 'edmond') oracle(raw);
    const jobs = await ({ css: fetchAllCssVersicherungJobs, duferco: fetchAllDufercoJobs, edmond: fetchAllEdmondDeRothschildJobs, elettra: fetchAllElettra1938Jobs })[key]();
    expect(jobs).toHaveLength(1);
    const date = key === 'duferco' ? '' : expected;
    expect(jobs[0]).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: date ? 'reported' : 'unknown' });
  });
});
it('Edmond validates the fallback independently when the primary publication is invalid', async () => {
  oracle('invalid', '2026-09-29T10:00:00Z');
  const jobs = await fetchAllEdmondDeRothschildJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: '2026-09-29T10:00:00Z', postedDate: '2026-09-29T10:00:00Z', postingDateSource: 'reported' });
});
