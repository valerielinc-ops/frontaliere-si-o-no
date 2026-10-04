import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';
import { fetchAllSpitexZuerichJobs } from '../scripts/lib/spitex-zuerich-job-parser.mjs';
import { fetchAllStiftungDiaconisJobs } from '../scripts/lib/stiftung-diaconis-job-parser.mjs';
import { fetchAllSuchtfachstelleZuerichJobs } from '../scripts/lib/suchtfachstelle-zuerich-job-parser.mjs';
import { fetchAllSuchthilfeRegionBaselJobs } from '../scripts/lib/suchthilfe-region-basel-job-parser.mjs';
import { fetchAllSuedhangJobs } from '../scripts/lib/suedhang-job-parser.mjs';
import { fetchAllUrovivaJobs } from '../scripts/lib/uroviva-job-parser.mjs';
import { fetchAllVistaJobs, parseVistaOstendisJob } from '../scripts/lib/vista-job-parser.mjs';
import { fetchAllStadtspitalZuerichJobs } from '../scripts/lib/stadtspital-zuerich-job-parser.mjs';
import { fetchOfficialAdTexts } from '../scripts/lib/stadt-zuerich-job-parser.mjs';
const body = 'Il personale infermieristico assicura cure professionali alle persone accolte nella struttura. '.repeat(20);
const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebPage', datePosted: '2026-09-01' }, { '@type': 'JobPosting', datePosted: date, description: body, jobStartDate: '2026-09-01', validThrough: '2030-12-31' }] })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'not-a-date', ''], ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const profiles = [
  ['spitex', fetchAllSpitexZuerichJobs, 'https://spitex-zuerich.onlyfy.jobs/', '<a data-testid="job-card" aria-label="Pflegefachperson" href="/de/job/abcd1234"><h3 data-testid="job-title">Pflegefachperson</h3></a>', fixture('./fixtures/spitex-zuerich/job-ad-full.html')],
  ['diaconis', fetchAllStiftungDiaconisJobs, 'https://diaconis.abacuscity.ch/', '<a href="https://diaconis.abacuscity.ch/de/job_1_86/Pflegefachperson">Pflegefachperson</a>', `<main><p>${body}</p></main>`],
  ['suchtfachstelle', fetchAllSuchtfachstelleZuerichJobs, 'https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen', '<a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-pflege">Pflegefachperson</a>', `<title>Pflegefachperson</title><section class="richtext"><p>${body}</p></section>`],
  ['suedhang', fetchAllSuedhangJobs, 'https://www.suedhang.ch/karriere/offene-stellen/', '<a href="https://www.suedhang.ch/karriere/offene-stellen/pflege/">Pflegefachperson</a>', `<h1>Pflegefachperson</h1><main><p>${body}</p></main>`],
  ['uroviva', fetchAllUrovivaJobs, 'https://jobs.dualoo.com/portal/nthmjmb4?lang=DE', '<a class="jobElement" href="00000000-0000-0000-0000-000000000001/detail" data-eventData="{&quot;startDate&quot;:&quot;01.09.2026&quot;,&quot;location&quot;:&quot;Bülach&quot;}"><span class="jobName">Pflegefachperson</span></a>', `<div class="advertisement"><div class="advertisementDescriptionText"><p>${body}</p></div></div>`],
] as const;
for (const [name, producer, listing, listHtml, detail] of profiles) describe(`${name} publication through actual producer`, () => {
  it.each(cases)('%s', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(urlOf(input) === listing ? listHtml : ld(raw) + detail));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
    expect(jobs[0].applyUrl).toMatch(/^https:\/\//);
    expect(jobs[0].id).toBeTruthy();
    expect(jobs[0].crawledAt).toBe('2026-10-04T12:00:00.000Z');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('Vista public API and typed detail', () => {
  it.each(cases)('%s', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('/ojp/data/')
      ? Response.json({ jobs: [{ id: 123, title: 'Pflegefachperson', city: 'Binningen', countrycode: 'CH', detail: 'https://link.ostendis.com/publication/pflege/123', action: 'https://link.ostendis.com/cvdropper/123/DE', timestamp: '2026-09-01' }] })
      : new Response(ld(raw)));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllVistaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].applyUrl).toBe('https://link.ostendis.com/cvdropper/123/DE');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not attest a legacy unmarked detail alias', () => {
    expect(parseVistaOstendisJob({ id: 123, title: 'Pflegefachperson', city: 'Binningen' }, { description: body, datePosted: '2026-09-01' })).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown', description: body });
  });
});
const cityListing = fixture('./__fixtures__/stadtspital-zuerich-listing.html');
const cityAd = fixture('./fixtures/stadt-zuerich-official-ad-gaertner.html');
function cityFetch(raw: unknown) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.includes('/stzh/jobsearch')) return Response.json({ results: ['49951', '17521'].map(ref => ({ href: `/de/jobs/job-detailseite.${ref}.html`, meta: ['Stadtspital Zürich', '2026-09-01'] })) });
    if (url.includes('job-detailseite.')) { const ref = /job-detailseite\.(\d+)/.exec(url)?.[1] || ''; return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, datePosted: raw })}</script>` + cityAd.replace(/51726/g, ref)); }
    return new Response(cityListing);
  });
}
describe('Stadtspital shared official ad evidence', () => {
  it.each(cases)('%s without borrowing index dates', async (_, raw, expected) => {
    const fetcher = cityFetch(raw); vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllStadtspitalZuerichJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
      expect(job.description.split(/\s+/).length).toBeGreaterThan(50);
      expect(job.applyUrl).toMatch(/^https:\/\//);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['foreign URL', [{ '@type': 'JobPosting', url: 'https://example.org/another-job', datePosted: '2026-09-01' }]],
    ['missing identity', [{ '@type': 'JobPosting', datePosted: '2026-09-01' }]],
    ['ambiguous matching records', [{ '@type': 'JobPosting', url: '/de/jobs/job-detailseite.49951.html', datePosted: '2026-09-01' }, { '@type': 'JobPosting', url: '/de/jobs/job-detailseite.49951.html', datePosted: '2026-09-02' }]],
    ['conflicting sameAs', [{ '@type': 'JobPosting', url: '/de/jobs/job-detailseite.49951.html', sameAs: 'https://example.org/other', datePosted: '2026-09-01' }]],
  ] as const)('rejects %s while preserving the official body', async (_, records) => {
    const baseFetch = cityFetch(undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('job-detailseite.')) return new Response(`<script type="application/ld+json">${JSON.stringify({ '@graph': records })}</script>` + cityAd.replace(/51726/g, /job-detailseite\.(\d+)/.exec(url)?.[1] || ''));
      return baseFetch(input);
    }));
    const jobs = await fetchAllStadtspitalZuerichJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(job.description.split(/\s+/).length).toBeGreaterThan(50);
      expect(job.applyUrl).toMatch(/^https:\/\//);
    }
  });
  it('selects a unique sameAs target after an unrelated posting', async () => {
    const baseFetch = cityFetch(undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('job-detailseite.')) return new Response(`<script type="application/ld+json">${JSON.stringify([{ '@type': 'JobPosting', url: 'https://example.org/foreign', datePosted: '2026-09-01' }, { '@type': 'JobPosting', sameAs: [url], datePosted: '2026-10-02' }])}</script>` + cityAd.replace(/51726/g, /job-detailseite\.(\d+)/.exec(url)?.[1] || ''));
      return baseFetch(input);
    }));
    const jobs = await fetchAllStadtspitalZuerichJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job).toMatchObject({ datePosted: '2026-10-02', postedDate: '2026-10-02', postingDateSource: 'reported' });
  });
  it('preserves the default shared Map of text contract', async () => {
    vi.stubGlobal('fetch', cityFetch('2026-09-01'));
    const texts = await fetchOfficialAdTexts(new Set(['49951']), 0, { unit: /stadtspital/i });
    expect(typeof texts.get('49951')).toBe('string');
    expect(texts.get('49951')!.split(/\s+/).length).toBeGreaterThan(50);
  });
});
describe('Suchthilfe PDF has no attested publication', () => {
  it.each(['2026-09-01', '2030-01-01'])('preserves ad without promoting PDF metadata %s', async date => {
    const pdf = new jsPDF(); pdf.setCreationDate(new Date(`${date}T12:00:00Z`)); pdf.text(pdf.splitTextToSize(`Stellenantritt ${date}. Bewerbungsfrist 31.12.2030. ${body}`, 170), 15, 20);
    const bytes = pdf.output('arraybuffer');
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input).endsWith('.pdf') ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('<a href="https://www.suchthilfe.ch/jobs/pflege.pdf" class="button-arrow"><span>Pflegefachperson</span></a>'));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllSuchthilfeRegionBaselJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].applyUrl).toBe('https://www.suchthilfe.ch/jobs/');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
