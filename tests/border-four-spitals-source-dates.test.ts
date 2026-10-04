import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const { renderDetails } = vi.hoisted(() => ({ renderDetails: vi.fn() }));
vi.mock('../scripts/lib/pi-asp-bewerber-web-detail.mjs', () => ({ renderPiAspDetailDescriptions: renderDetails }));
import { fetchAllSpitalDavosJobs } from '../scripts/lib/spital-davos-job-parser.mjs';
import { fetchAllSpitalThusisJobs } from '../scripts/lib/spital-thusis-job-parser.mjs';
import { fetchAllSpitalZofingenJobs } from '../scripts/lib/spital-zofingen-job-parser.mjs';
import { fetchAllSpitalZollikerbergJobs } from '../scripts/lib/spital-zollikerberg-job-parser.mjs';
const UNKNOWN = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const DATE = '2020-06-15T10:11:12.123+02:00';
const reported = (raw = DATE) => ({ datePosted: raw, postedDate: raw, postingDateSource: 'reported' });
const BODY = 'Wir betreuen unsere Patientinnen und Patienten während der stationären Behandlung und begleiten ihre Familien mit grossem Engagement. Sie planen die therapeutischen Massnahmen selbständig, dokumentieren die Fortschritte und arbeiten eng mit dem ärztlichen Dienst zusammen. Wir wünschen uns eine abgeschlossene Ausbildung sowie Erfahrung in der interdisziplinären Zusammenarbeit. Unser Team unterstützt Sie während der Einführung und bietet regelmässige Weiterbildung sowie einen abwechslungsreichen Arbeitsalltag im regionalen Spital mit moderner Infrastruktur.';
afterEach(() => { vi.unstubAllGlobals(); renderDetails.mockReset(); });

describe('Zofingen native heading and typed JobPosting publication', () => {
  const url = 'https://jobs.spitalzofingen.ch/offene-stellen/pflege/abc123';
  it.each([
    { label: 'full offset', raw: DATE, expected: reported() },
    { label: 'native singleton without URL', raw: DATE, identity: false, expected: reported() },
    { label: 'missing', raw: undefined, expected: UNKNOWN },
    { label: 'invalid date', raw: '2020-02-30', expected: UNKNOWN },
    { label: 'future', raw: '2999-01-01', expected: UNKNOWN },
    { label: 'foreign URL', raw: DATE, otherUrl: true, expected: UNKNOWN },
    { label: 'different heading', raw: DATE, heading: 'Other vacancy', expected: UNKNOWN },
    { label: 'multiple postings', raw: DATE, multiple: true, expected: UNKNOWN },
  ])('$label survives fetch → job without clock', async ({ raw, expected, identity = true, otherUrl = false, heading = 'Pflegefachperson', multiple = false }) => {
    const posting = { '@type': 'JobPosting', title: 'Pflegefachperson', description: BODY,
      url: identity ? (otherUrl ? `${url}-other` : url) : undefined,
      datePosted: raw, validThrough: '2020-01-01', dateModified: '2020-01-01',
      jobLocation: { address: { addressLocality: 'Zofingen', addressRegion: 'Aargau', addressCountry: 'CH', postalCode: '4800' } } };
    const detail = `<h1>${heading}</h1><script type="application/ld+json">${JSON.stringify(multiple ? [posting, { ...posting, title: 'Other vacancy' }] : posting)}</script>`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === url ? detail : `<a href="${url}">Pflegefachperson</a>`)));
    const jobs = await fetchAllSpitalZofingenJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...expected, title: 'Pflegefachperson', url, canton: 'AG' });
    expect(jobs[0].description).toContain('stationären Behandlung');
  });
});

for (const metadata of ['', '<meta name="dateModified" content="2020-06-15"><p>Erstellt am 15.06.2020</p>']) {
  it(`Davos emits unknown with non-publication metadata ${metadata}`, async () => {
    const listing = '<tr class="table-as-list__contentrow1"><td><a href="/Vacancies/699/Description/1">Pflegefachperson 80%</a></td></tr>';
    const detail = `<h1>Pflegefachperson 80%</h1><div id="text">${BODY}</div>${metadata}`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('/Vacancies/') ? detail : listing)));
    const jobs = await fetchAllSpitalDavosJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, canton: 'GR', location: 'Davos' });
    expect(jobs[0].description).toContain('stationären Behandlung');
  });
  it(`Thusis preserves source body and unknown publication ${metadata}`, async () => {
    const listing = '<h2 class="teaserHeadline"><a href="/karriere-jobs/offene-stellen/physiotherapeut-in/">Physiotherapeut/in 80 - 100%</a></h2>';
    const detail = `<h2>Physiotherapeut/in 80 - 100%</h2><h4>Dein Aufgabengebiet:</h4><p>${BODY}</p><h4>Dein Anforderungsprofil:</h4><p>Abgeschlossene Berufsausbildung und Freude an der Zusammenarbeit.</p>${metadata}`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('/physiotherapeut-in/') ? detail : listing)));
    const jobs = await fetchAllSpitalThusisJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, canton: 'GR', location: 'Thusis' });
    expect(jobs[0].description).toContain('stationären Behandlung');
  });
  it(`Zollikerberg keeps renderer description separate from publication ${metadata}`, async () => {
    const listing = readFileSync(new URL('./fixtures/gesundheitswelt-zollikerberg-listing.html', import.meta.url), 'utf8');
    renderDetails.mockImplementation(async (urls: string[]) => new Map(urls.map((url) => [url, BODY])));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(listing + metadata)));
    const jobs = await fetchAllSpitalZollikerbergJobs();
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job).toMatchObject({ ...UNKNOWN, canton: 'ZH', location: 'Zollikerberg' });
      expect(job.description).toContain('stationären Behandlung');
    }
    expect(renderDetails).toHaveBeenCalledTimes(1);
  });
}
