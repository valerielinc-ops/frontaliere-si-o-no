import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { fetchAllPdgrJobs } from '../scripts/lib/pdgr-job-parser.mjs';
import { fetchAllPrivatklinikWyssJobs } from '../scripts/lib/privatklinik-wyss-job-parser.mjs';
import { fetchAllRennbahnklinikJobs } from '../scripts/lib/rennbahnklinik-job-parser.mjs';
import { fetchAllProSenectuteTiJobs } from '../scripts/lib/prosenectute-ti-job-parser.mjs';
import { fetchAllRehaAndeerJobs } from '../scripts/lib/reha-andeer-job-parser.mjs';
const body = 'Il personale infermieristico assicura cure professionali alle persone accolte nella struttura. '.repeat(20);
const ld = (date: unknown, type = 'JobPosting') => `<script type="application/ld+json">${JSON.stringify({ '@type': type, datePosted: date, jobStartDate: '2026-09-01', dateModified: '2026-09-02', validThrough: '2030-12-31' })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'bad-date', ''], ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const profiles = [
  ['pdgr', fetchAllPdgrJobs, 'https://www.pdgr.ch/jobs-uebersicht/offene-stellen/', '<div class="jobs-post grid-item pflege" data-efrom="80" data-eto="100"><a href="https://www.pdgr.ch/jobs/pflege/"><p class="mb-0 job-title"><b>Pflegefachperson</b></p><span>Arbeitsort: Chur</span></a></div></div>', `<span id="acf_jobs_duties">${body}</span>`, 2],
  ['rennbahn', fetchAllRennbahnklinikJobs, 'https://www.rennbahnklinik.ch/offene-stellen', '<a href="https://www.rennbahnklinik.ch/jobs/pflege">Pflegefachperson</a>', `<h1>Pflegefachperson</h1><main><div class="component component-text"><p>${body}</p></div></main>`, 2],
  ['wyss', fetchAllPrivatklinikWyssJobs, 'https://www.privatklinik-wyss.ch/jobs-und-karriere/stellen/fachbereich-pflege-1', '<a href="/jobs-und-karriere/stellen/fachbereich-pflege-1/pflege">Pflegefachperson</a>', `<title>Pflegefachperson | Privatklinik Wyss</title><main><p>${body}</p><p>Arbeitsbeginn:01.09.2026</p></main>`, 10],
] as const;
for (const [name, producer, listingUrl, listingHtml, detailHtml, requestCount] of profiles) describe(`${name} typed JobPosting publication`, () => {
  it.each(cases)('%s without page metadata promotion', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url === listingUrl) return new Response(listingHtml);
      if (name === 'wyss' && !url.endsWith('/pflege')) return new Response('');
      return new Response(ld('2026-09-01', 'WebPage') + ld(raw) + detailHtml);
    });
    vi.stubGlobal('fetch', fetcher);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].applyUrl).toMatch(/^https:\/\//);
    expect(jobs[0].id.length).toBeGreaterThan(5);
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
  });
});
const pdfProfiles = [
  ['prosenectute', fetchAllProSenectuteTiJobs, 'https://ti.prosenectute.ch/it/collabora-con-noi/Offerte-di-lavoro.html', '<a href="/dam/concorso-infermiere.pdf" class="download-icon-before-link">Concorso infermiere</a>'],
  ['andeer', fetchAllRehaAndeerJobs, 'https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer', '<a href="https://reha-andeer.ch/uploads/Pflegefachperson.pdf">Pflegefachperson</a>'],
] as const;
for (const [name, producer, listingUrl, listingHtml] of pdfProfiles) describe(`${name} PDF source has no verified publication`, () => {
  it.each(['2026-09-01', '2030-01-01'])('preserves body without promoting creation/start/deadline %s', async date => {
    const doc = new jsPDF(); doc.setCreationDate(new Date(`${date}T00:00:00Z`));
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
