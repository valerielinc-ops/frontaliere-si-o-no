import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllSpitalAffolternJobs } from '../scripts/lib/spital-affoltern-job-parser.mjs';
import { fetchAllSpitalStsJobs } from '../scripts/lib/spital-sts-job-parser.mjs';
import { fetchAllUkbbJobs } from '../scripts/lib/ukbb-job-parser.mjs';

const UNKNOWN = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const BODY = 'Wir betreuen unsere Patientinnen und Patienten während der stationären Behandlung und begleiten ihre Familien mit grossem Engagement. Sie planen die therapeutischen Massnahmen selbständig, dokumentieren die Fortschritte und arbeiten eng mit dem ärztlichen Dienst zusammen. Wir wünschen uns eine abgeschlossene Ausbildung sowie Erfahrung in der interdisziplinären Zusammenarbeit. Unser Team unterstützt Sie während der Einführung und bietet regelmässige Weiterbildung sowie einen abwechslungsreichen Arbeitsalltag im regionalen Spital mit moderner Infrastruktur.';
const UUID = '0f5298d2-65a5-460c-831e-46a1761c5691';
const TITLE = 'Pflegefachperson';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const metadata of ['', '<meta name="dateModified" content="2020-06-15"><p>Erstellt am 15.06.2020</p>']) {
  it(`Affoltern keeps employment start distinct from publication ${metadata}`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const url = `https://jobs.dualoo.com/portal/8n6b8ihk/${UUID}/detail?lang=DE`;
    const listing = `<a class="jobElement" href="8n6b8ihk/${UUID}/detail?lang=DE" data-eventData="{&quot;jobName&quot;:&quot;Pflegefachperson&quot;,&quot;startDate&quot;:&quot;2020-06-15&quot;,&quot;location&quot;:&quot;Affoltern am Albis&quot;}"></a>`;
    const fetchMock = vi.fn(async (input: string | URL) => new Response(String(input) === url ? `<div class="row advertisement"><p>${BODY}</p></div>${metadata}` : listing));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchAllSpitalAffolternJobs();
    await vi.runAllTimersAsync();
    const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, url, title: TITLE, location: 'Affoltern am Albis' });
    expect(jobs[0].description).toContain('stationären Behandlung');
    expect(fetchMock.mock.calls.some(([input]) => String(input) === url)).toBe(true);
  });
  it(`STS emits unknown without source publication ${metadata}`, async () => {
    const url = `https://jobs.spitalstsag.ch/offene-stellen/pflege/${UUID}`;
    const listing = `<div class="job job-1"><a id="job-1" href="${url}" data-location="Thun"><h3 class="title">${TITLE}</h3></a></div>`;
    const fetchMock = vi.fn(async (input: string | URL) => new Response(String(input) === url ? `<section id="introduction"><p>${BODY}</p></section>${metadata}` : listing));
    vi.stubGlobal('fetch', fetchMock);
    const jobs = await fetchAllSpitalStsJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...UNKNOWN, title: TITLE, location: 'Thun', canton: 'BE' });
    expect(jobs[0].description).toContain('stationären Behandlung');
    expect(fetchMock.mock.calls.some(([input]) => String(input) === url)).toBe(true);
  });
}

const UKBB_URL = `https://jobs.ukbb.ch/jobs/pflege/${UUID}`;
async function ukbb(raw: unknown, options: { heading?: string; identity?: string; extra?: boolean } = {}) {
  const posting = { '@type': 'JobPosting', title: TITLE, description: BODY, datePosted: raw, url: options.identity ?? UKBB_URL, dateModified: '2020-06-15', validThrough: '2020-07-15' };
  const detail = `<h1>${options.heading ?? TITLE}</h1><script type="application/ld+json">${JSON.stringify({ '@graph': options.extra ? [posting, { ...posting, title: 'Other vacancy' }] : [posting] })}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === UKBB_URL ? detail : `<urlset><url><loc>${UKBB_URL}</loc><lastmod>2020-06-15</lastmod></url></urlset>`)));
  const jobs = await fetchAllUkbbJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ title: TITLE, url: UKBB_URL, location: 'Basel' });
  expect(jobs[0].description).toContain('stationären Behandlung');
  return jobs[0];
}
describe('UKBB same-vacancy publication through sitemap → detail → builder', () => {
  it('preserves the full timestamp and provenance', async () => {
    const date = '2020-06-15T08:12:10.123+02:00';
    expect(await ukbb(date)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
  });
  it.each([undefined, '', '2020-02-30', '2020-06-15junk', '2999-06-15', '2020-06-15T25:00:00Z'])('rejects absent or invalid source %s', async (raw) => {
    expect(await ukbb(raw)).toMatchObject(UNKNOWN);
  });
  it.each([{ heading: '' }, { heading: 'Other vacancy' }, { identity: 'https://jobs.ukbb.ch/jobs/other/' }, { extra: true }])('rejects ambiguous identity %j', async (options) => {
    expect(await ukbb('2020-06-15', options)).toMatchObject(UNKNOWN);
  });
});
