import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { fetchAllMerianIselinJobs } from '../scripts/lib/merian-iselin-job-parser.mjs';
import { fetchAllMoncuccoJobs } from '../scripts/lib/moncucco-job-parser.mjs';
import { fetchAllNantJobs } from '../scripts/lib/nant-job-parser.mjs';
import { fetchAllOscamCastelrottoJobs } from '../scripts/lib/oscam-castelrotto-job-parser.mjs';
import { fetchAllPalliativklinikJobs } from '../scripts/lib/palliativklinik-job-parser.mjs';
const body = 'Il personale infermieristico assicura cure professionali alle persone accolte nella struttura. '.repeat(20);
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: date, jobStartDate: '2026-09-01', dateModified: '2026-09-02', validThrough: '2030-12-31' })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'bad-date', ''], ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const profiles = [
  ['merian', fetchAllMerianIselinJobs, 'https://merianiselin.ch/klinik/jobs/offene-stellen', '<li class="jobs-list__item"><a href="https://merianiselin.ch/jobs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" class="jobs-list__link"><span>Diplomierte Pflegefachperson</span><span>80%</span></a></li>', `<div class="job-detail__content"><p>${body}</p></div>`],
  ['moncucco', fetchAllMoncuccoJobs, 'https://www.moncucco.ch/lavora-con-noi.php', '<div class="item-job"><a href="https://www.moncucco.ch/infermiere.php5"><h3>Infermiere diplomato</h3><div class="info-job">Disponibilità: 01.09.2026</div></a></div>', `<div class="testo-pagina"><p>${body}</p></div>`],
] as const;
for (const [name, producer, listingUrl, listingHtml, detailHtml] of profiles) describe(`${name} genuine detail publication`, () => {
  it.each(cases)('%s', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(urlOf(input) === listingUrl ? listingHtml : ld(raw) + detailHtml));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].applyUrl).toMatch(/^https:\/\//);
    expect(jobs[0].id.length).toBeGreaterThan(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
it.each(['', '2026-09-01', '2030-01-01'])('Nant keeps campaign without promoting created/expiry %s', async (date) => {
  const fetcher = vi.fn(async () => Response.json({ campaigns: [{ _id: '123', title: { '1': 'Infirmier diplômé' }, description: { '1': body }, inviteLink: 'https://app.beehire.com/invite/nant-example', createdAt: date, inviteExp: date, location: { city: 'Corsier-sur-Vevey', state: 'VD' } }] }));
  vi.stubGlobal('fetch', fetcher);
  const jobs = await fetchAllNantJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown', applyUrl: 'https://app.beehire.com/invite/nant-example' });
  expect(jobs[0].description).toContain('cure professionali');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
const pdfProfiles = [
  ['oscam', fetchAllOscamCastelrottoJobs, 'https://www.oscam.ch/lavoraconnoi/', '<h2>CONCORSI ATTIVI</h2><h3>Concorso infermiere diplomato</h3><h4><a href="https://www.oscam.ch/bando-infermiere.pdf">Apri il bando</a></h4>'],
  ['palliativ', fetchAllPalliativklinikJobs, 'https://palliativklinik.ch/offene-stellen/', '<p>Dipl. Pflegefachperson 80% <a href="https://palliativklinik.ch/wordpress/wp-content/uploads/PKiP_Pflege.pdf">PDF</a></p>'],
] as const;
for (const [name, producer, listingUrl, listingHtml] of pdfProfiles) describe(`${name} genuine PDF body without publication inference`, () => {
  it.each(['2026-09-01', '2030-01-01'])('does not promote PDF creation/start/deadline %s', async (date) => {
    const doc = new jsPDF();
    doc.setCreationDate(new Date(`${date}T00:00:00Z`));
    doc.text(doc.splitTextToSize(`${body} Entrata ${date}. Scadenza ${date}.`, 175), 15, 20);
    const bytes = doc.output('arraybuffer');
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input) === listingUrl ? new Response(listingHtml) : new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].url).toContain('.pdf');
    expect(jobs[0].applyUrl).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
