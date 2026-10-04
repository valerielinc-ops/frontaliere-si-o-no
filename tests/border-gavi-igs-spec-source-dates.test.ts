import { afterEach, describe, expect, it, vi } from 'vitest';
type SpecRow = { title: string; url: string; description: string; location: string; addressLocality: string; addressRegion: string; addressCountry: string; datePosted?: string; postedDate?: string; postingDateSource?: string };
const source = vi.hoisted(() => ({ rows: [] as SpecRow[] }));
vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (original) => ({ ...await original<typeof import('../scripts/lib/prospector/spec-crawler.mjs')>(), loadSpec: () => ({}) }));
vi.mock('../scripts/lib/ipersonal-spec-runtime.mjs', () => ({ runIpersonalSpecInProduction: async () => source.rows, getVerifiedIpersonalGeography: () => null }));
vi.mock('../scripts/lib/umantis-empty-listing.mjs', async (original) => ({ ...await original<typeof import('../scripts/lib/umantis-empty-listing.mjs')>(), runUmantisSpecWithEmptyProof: async () => source.rows }));
import { fetchAllIpersonalJobs } from '../scripts/lib/ipersonal-job-parser.mjs';
import { fetchAllJsafrasarasinJobs } from '../scripts/lib/jsafrasarasin-job-parser.mjs';
import { fetchAllGaviJobs } from '../scripts/lib/gavi-job-parser.mjs';
import { fetchAllIgsBernJobs } from '../scripts/lib/igs-bern-job-parser.mjs';
const date = '2025-09-29T23:45:12+02:00';
const text = 'Qualified professionals work together to support clients and maintain reliable services. Responsibilities include careful planning and documentation as well as collaboration with colleagues and partners throughout every project. '.repeat(5);
const expected = (value = '') => ({ datePosted: value, postedDate: value, postingDateSource: value ? 'reported' : 'unknown' });
afterEach(() => { vi.unstubAllGlobals(); source.rows = []; });

// These two suites isolate the producer contract. Upstream spec extraction is
// owned and tested separately; no claim that these mocks exercise its crawler.
for (const [name, run, url] of [
  ['iPersonal', fetchAllIpersonalJobs, 'https://med-ipersonal.ch/jobs/pflege-lugano/'],
  ['J Safra', fetchAllJsafrasarasinJobs, 'https://jsafrasarasin.umantis.com/Vacancies/123/Description/2'],
] as const) {
  describe(`${name} normalized evidence to published producer`, () => {
    for (const [label, fields] of [
      ['reported', expected(date)], ['unknown', expected()],
      ['legacy', { postedDate: date }], ['invalid', { ...expected('2025-02-30'), postingDateSource: 'reported' }],
      ['future', { ...expected('2999-01-01'), postingDateSource: 'reported' }],
    ] as const) {
      it(`${label}: conserves only validated provenance`, async () => {
        source.rows = [{ title: 'Client Services Specialist', url, description: text, location: 'Lugano', addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH', ...fields }];
        const jobs = await run();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ url, canton: 'TI', ...expected(label === 'reported' ? date : '') });
        expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      });
    }
  });
}
const portal = 'https://fs-2662.my.salesforce-sites.com';
const gaviList = `${portal}/recruit/fRecruit__ApplyJobList?portal=Global`;
const gaviUrl = `${portal}/recruit/fRecruit__ApplyJob?vacancyNo=VN001&portal=Global`;
const gaviPosting = (raw: unknown) => ({ '@type': 'JobPosting', url: gaviUrl, datePosted: raw, validThrough: '2999-12-31' });
function stubGavi(posting: unknown) {
  const list = '<table class="list jobListPanel"><tr class="dataRow"><td class="dataCell"><span><span>VN001</span></span></td><td class="dataCell"><span><a href="/recruit/fRecruit__ApplyJob?vacancyNo=VN001&amp;portal=Global">Programme Officer</a></span></td><td class="dataCell"><span><span>Geneva</span></span></td><td class="dataCell"><span>01 Jan 2999</span></td></tr></table>';
  const detail = `<script type="application/ld+json">${JSON.stringify(posting)}</script><table><tr><th class="labelCol"><label>Location</label></th><td class="data2Col">Geneva</td></tr><tr><th class="labelCol"><label>Job Description</label></th><td class="data2Col">${text}</td></tr></table>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input) === gaviList) return new Response(list);
    if (String(input) === gaviUrl) return new Response(detail);
    throw new Error(`Unexpected request ${input}`);
  }));
}
describe('Gavi real HTTP listing/detail publication evidence', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: no expiry, listing date or crawl substitution`, async () => {
      stubGavi(gaviPosting(raw));
      const jobs = await fetchAllGaviJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ url: gaviUrl, canton: 'GE', ...expected(label === 'timestamp' ? date : '') });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
    });
  }
  it('keeps unknown when explicit vacancy identity is missing', async () => {
    stubGavi({ ...gaviPosting(date), url: undefined });
    expect((await fetchAllGaviJobs())[0]).toMatchObject(expected());
  });
  it('rejects a different vacancyNo in the detail JSON-LD', async () => {
    stubGavi({ ...gaviPosting(date), url: gaviUrl.replace('VN001', 'VN002') });
    expect((await fetchAllGaviJobs())[0]).toMatchObject(expected());
  });
});
const igsUrl = 'https://www.publicjobs.ch/jobs/igs-pflege';
const igsPosting = (raw: unknown) => ({ '@type': 'JobPosting', url: igsUrl, datePosted: raw });
function stubIgs(posting: unknown, extraForeign = false) {
  const row = { job_title: 'Pflegefachperson 80%', job_detail_url: igsUrl, org_name: 'IGS Bern', org_city: 'Bern BE', job_booking_start: '29.09.2025' };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).includes('/widget')) return new Response(JSON.stringify({ data: extraForeign ? [row, { ...row, org_name: 'Other Hospital', job_detail_url: 'https://www.publicjobs.ch/jobs/other' }] : [row] }), { headers: { 'Content-Type': 'application/json' } });
    if (String(input) === igsUrl) return new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script><div id="template_preview_job_description"><p>${text}</p></div>`);
    throw new Error(`Unexpected request ${input}`);
  }));
}
describe('IGS real widget/detail publication evidence', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: booking start is not promoted to publication`, async () => {
      stubIgs(igsPosting(raw));
      const jobs = await fetchAllIgsBernJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ url: igsUrl, canton: 'BE', ...expected(label === 'timestamp' ? date : '') });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
    });
  }
  it('does not attest foreign detail identity', async () => {
    stubIgs({ ...igsPosting(date), url: 'https://www.publicjobs.ch/jobs/other' });
    expect((await fetchAllIgsBernJobs())[0]).toMatchObject(expected());
  });
  it('preserves the company guard before fetching unrelated detail', async () => {
    stubIgs(igsPosting(date), true);
    const jobs = await fetchAllIgsBernJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url: igsUrl, ...expected(date) });
  });
});
