import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ html: vi.fn(), json: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async original => ({
  ...await original<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml: io.html, fetchJson: io.json,
}));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async original => ({
  ...await original<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>(), fetchHtml: io.html,
}));
import { fetchAllDecathlonJobs } from '../scripts/lib/decathlon-job-parser.mjs';
import { fetchAllEtavisJobs } from '../scripts/lib/etavis-job-parser.mjs';
import { fetchAllJosefMuellerJobs } from '../scripts/lib/josef-mueller-job-parser.mjs';
import { fetchAllKispiJobs } from '../scripts/lib/kispi-job-parser.mjs';
import { fetchAllKsglJobs } from '../scripts/lib/ksgl-job-parser.mjs';
import { fetchAllLupsJobs } from '../scripts/lib/lups-job-parser.mjs';
import { fetchAllSikaJobs } from '../scripts/lib/sika-job-parser.mjs';
import { fetchAllSroJobs } from '../scripts/lib/sro-job-parser.mjs';
import { fetchAllGivaudanJobs } from '../scripts/lib/givaudan-job-parser.mjs';

const description = '<p>' + 'Wir suchen erfahrene Fachpersonen für unser Team in der Schweiz. Sie arbeiten gemeinsam mit engagierten Kolleginnen und Kollegen und übernehmen verantwortungsvolle Aufgaben in einem abwechslungsreichen Arbeitsumfeld. Wir bieten eine sorgfältige Einführung sowie kontinuierliche Weiterbildung und moderne Arbeitsbedingungen. Ihre Aufgaben umfassen die Planung und Durchführung unserer Dienstleistungen sowie die Zusammenarbeit mit anderen Fachbereichen. Sie bringen eine abgeschlossene Ausbildung mit und freuen sich auf die tägliche Arbeit mit Menschen. Unsere Mitarbeitenden unterstützen Sie bei allen Fragen und begleiten Ihren Einstieg in die neue Tätigkeit.' + '</p>';
const uuid = '6f40d3fb-1b2e-4b1e-b007-be232b4bd78b';
const subjects = ['decathlon', 'etavis', 'josef-mueller', 'kispi', 'ksgl', 'lups', 'sika', 'givaudan', 'sro'] as const;
type Subject = typeof subjects[number];

function fixtures(subject: Subject, datePosted: unknown, listingDate: unknown = datePosted) {
  const detail = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Fachperson Software Engineering',
    description, datePosted, validThrough: '2026-09-28', dateCreated: '2026-09-27', dateModified: '2026-10-03',
    inLanguage: 'de', employmentType: 'FULL_TIME', hiringOrganization: { name: 'Source employer' },
    jobLocation: { address: { addressCountry: 'CH', addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900' } },
  })}</script></head><body>${description}</body></html>`;
  let listing = `<a class="platform-item item-123" href="https://jobs.example.ch/offene-stellen/fachperson/${uuid}" title="Fachperson Software Engineering">Fachperson</a>`;
  if (subject === 'lups') listing = listing.replace('platform-item item-123', 'job job-123');
  if (subject === 'sro') listing = `<article class="col-md-4"><a href="https://ohws.prospective.ch/public/v1/jobs/${uuid}"><h4>Fachperson Software Engineering</h4></a><address>Spital Langenthal</address></article>`;
  if (subject === 'kispi') listing = `<a href="https://stellen.kispi-jobs.ch/offene-stellen/fachperson/${uuid}">Fachperson</a>`;
  if (subject === 'josef-mueller') listing = `<a href="/en/vacancies/detail/${uuid}/">Fachperson</a>`;
  if (subject === 'etavis') listing = '<div class="matchElement" id="job_id_64115798"><div class="matchValue title"><a href="../job/64115798/fachperson?jobDbPVId=276097451&amp;l=de">Fachperson Software Engineering</a></div><div class="matchValue ProjectGeoLocationCity"><span class="location-view-item">Lugano</span></div><div class="matchValue sg_company_id">ETAVIS Elettro-Impianti SA</div></div>';
  // Route listing/detail on their production URL shapes, never mock business/date helpers.
  io.html.mockImplementation(async (url: string) => {
    if (subject === 'etavis') return url.includes('/job/') ? detail : listing;
    if (subject === 'josef-mueller') return url.includes('/companies/') ? listing : detail;
    if (subject === 'kispi') return url.includes('/offene-stellen/') ? detail : listing;
    return detail;
  });
  io.json.mockImplementation(async () => subject === 'givaudan'
    ? { refineSearch: { totalHits: 1, data: { jobs: [{ jobSeqNo: 'GIV123', title: 'Fachperson Software Engineering', country: 'Switzerland', cityStateCountry: 'Lugano, Switzerland', postedDate: listingDate, dateCreated: '2026-09-27T10:00:00+0000', description }] } } }
    : { count: 1, nextOffset: null, items: [{ title: 'Fachperson Software Engineering', url: subject === 'sika' ? 'https://jobs.sika.com/job/fachperson-123' : 'fachperson-123', location: 'Lugano', country: 'Switzerland', description }] });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => ({ ok: true, status: 200, text: async () => (String(url).includes('/careercenter/') || String(url).includes('/karriere/stellenangebote/')) ? listing : detail })));
}
const producers = {
  decathlon: () => fetchAllDecathlonJobs(), etavis: () => fetchAllEtavisJobs({ _fetchHtml: io.html }),
  'josef-mueller': () => fetchAllJosefMuellerJobs({ fetchPage: io.html }), kispi: () => fetchAllKispiJobs(),
  ksgl: () => fetchAllKsglJobs(), lups: () => fetchAllLupsJobs(), sika: () => fetchAllSikaJobs(), givaudan: () => fetchAllGivaudanJobs(), sro: () => fetchAllSroJobs(),
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  io.html.mockReset(); io.json.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('additional dedicated producers preserve only source publication', () => {
  for (const subject of subjects) it.each([
    ['2026-09-29T23:15:00+02:00', '2026-09-29T23:15:00+02:00'],
    [undefined, ''], ['2026-02-30', ''], ['2026-10-05T00:00:00Z', ''],
  ])(`${subject}: datePosted %s`, async (raw, expected) => {
    fixtures(subject, raw);
    const jobs = await producers[subject]();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown'});
  });
  it.each([{ raw: ['2026-09-29'] }, { raw: 123 }, { raw: { value: '2026-09-29' } }])('Josef rejects non-string publication $raw', async ({ raw }) => {
    fixtures('josef-mueller', raw);
    const jobs = await producers['josef-mueller']();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({datePosted: '', postedDate: '', postingDateSource: 'unknown'});
  });
  it('Givaudan preserves genuine compact offset listing publication when detail date is missing', async () => {
    fixtures('givaudan', undefined, '2026-09-29T23:15:00+0200');
    const jobs = await producers.givaudan();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({datePosted: '2026-09-29T23:15:00+02:00', postedDate: '2026-09-29T23:15:00+02:00', postingDateSource: 'reported'});
  });
});
