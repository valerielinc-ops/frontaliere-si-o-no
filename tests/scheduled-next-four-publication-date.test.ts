import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ json: vi.fn(), html: vi.fn(), page: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({ ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchJson: io.json }));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async original => ({ ...await original<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>(), fetchHtml: io.html }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async original => ({ ...await original<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(), politeFetch: io.page }));
import { fetchAllBlattersHotelJobs } from '../scripts/lib/blatters-hotel-job-parser.mjs';
import { fetchAllBucherSuterJobs } from '../scripts/lib/bucher-suter-job-parser.mjs';
import { fetchAllCleniaAgJobs } from '../scripts/lib/clienia-ag-job-parser.mjs';
import { fetchAllCliniqueDeLaPlaineJobs } from '../scripts/lib/clinique-de-la-plaine-job-parser.mjs';
const prose = 'Unser Team sucht erfahrene Fachpersonen mit einer abgeschlossenen Ausbildung und Freude an der Zusammenarbeit. '.repeat(10);
const cases = [['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'], [undefined, ''], ['2026-02-30', ''], ['2026-10-05', '']] as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); io.json.mockReset(); io.html.mockReset(); io.page.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
for (const key of ['blatters', 'bucher', 'clienia', 'plaine'] as const) describe(`${key} publication through real producer`, () => {
  it.each(cases)('validates explicit publication %s', async (raw, expected) => {
    const url = key === 'blatters' ? 'https://www.hotelcareer.ch/jobs/blatter-s-hotel-arosa-4340/chef-123' : key === 'bucher' ? 'https://www.bucher-suter.com/job-listings/engineer/' : key === 'clienia' ? 'https://www.clienia.ch/job-listings/engineer/' : 'https://laplaine.ch/emploi/infirmier/';
    io.json.mockResolvedValue([{ id: 123, link: url, title: { rendered: 'Fachperson Engineering' }, date: raw, modified: '2026-10-03T10:00:00Z' }]);
    const article = `<article class="wp-show-posts-single"><h2 class="wp-show-posts-entry-title"><a href="${url}">Infirmier qualifié</a></h2>${raw ? `<time class="wp-show-posts-entry-date published" datetime="${raw}"></time>` : ''}</article>`;
    io.html.mockImplementation(async (requested: string) => requested === url ? `<p>Location</p><p>Bern, Switzerland</p><div class="article-prose"><p>Ihre Aufgaben ${prose}</p></div><div class="et_pb_text_inner">${prose}</div>` : article);
    const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Chef de Partie', description: prose, datePosted: raw, dateModified: '2026-10-03', jobLocation: { address: { addressLocality: 'Arosa', addressCountry: 'CH' } } })}</script>`;
    io.page.mockImplementation(async (requested: string) => ({ ok: true, status: 200, url: requested, body: requested === url ? detail : `<a href="${url}">Chef de Partie</a>` }));
    const jobs = await ({ blatters: fetchAllBlattersHotelJobs, bucher: fetchAllBucherSuterJobs, clienia: fetchAllCleniaAgJobs, plaine: fetchAllCliniqueDeLaPlaineJobs })[key]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(url);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
it('La Plaine never borrows a publication from the following record', async () => {
  const first = 'https://laplaine.ch/emploi/premier/';
  const second = 'https://laplaine.ch/emploi/second/';
  const card = (url: string, date = '') => `<article class="wp-show-posts-single"><h2 class="wp-show-posts-entry-title"><a href="${url}">Infirmier qualifié</a></h2>${date}</article>`;
  io.html.mockImplementation(async (url: string) => url === first || url === second ? `<div class="et_pb_text_inner">${prose}</div>` : card(first) + card(second, '<time class="wp-show-posts-entry-date published" datetime="2026-09-29T10:00:00Z"></time>'));
  const jobs = await fetchAllCliniqueDeLaPlaineJobs();
  expect(jobs).toHaveLength(2);
  expect(jobs.find(job => job.url === first)).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  expect(jobs.find(job => job.url === second)).toMatchObject({ datePosted: '2026-09-29T10:00:00Z', postedDate: '2026-09-29T10:00:00Z', postingDateSource: 'reported' });
});

for (const key of ['bucher', 'clienia'] as const) it.each([
  [{ date: '2026-09-29T10:20:30' }, '2026-09-29'],
  [{ date: '2026-09-29T10:20:30', date_gmt: '2026-09-29T08:20:30' }, '2026-09-29T08:20:30Z'],
  [{ date: '2026-09-29T10:20:30', date_gmt: '2026-02-30T08:20:30' }, '2026-09-29'],
  [{ date: '2026-02-30T10:20:30' }, ''],
  [{ date: '2026-09-29T25:20:30' }, ''],
] as const)(`${key} WordPress local/GMT publication`, async (fields, expected) => {
  const url = key === 'bucher' ? 'https://www.bucher-suter.com/job-listings/engineer/' : 'https://www.clienia.ch/job-listings/engineer/';
  io.json.mockResolvedValue([{ id: 123, link: url, title: { rendered: 'Fachperson Engineering' }, ...fields, modified: '2026-10-03T10:00:00', modified_gmt: '2026-10-03T08:00:00' }]);
  io.html.mockResolvedValue(`<p>Location</p><p>Bern, Switzerland</p><div class="article-prose"><p>Ihre Aufgaben ${prose}</p></div>`);
  const jobs = await (key === 'bucher' ? fetchAllBucherSuterJobs() : fetchAllCleniaAgJobs());
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
});
