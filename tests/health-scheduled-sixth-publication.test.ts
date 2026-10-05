import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKlinikAadorfJobs } from '../scripts/lib/klinik-aadorf-job-parser.mjs';
import { fetchAllKlinikArlesheimJobs } from '../scripts/lib/klinik-arlesheim-job-parser.mjs';
import { fetchAllKlinikAdelheidJobs } from '../scripts/lib/klinik-adelheid-job-parser.mjs';
import { fetchAllKlinikBarmelweidJobs } from '../scripts/lib/klinik-barmelweid-job-parser.mjs';
import { fetchAllKlinikGutJobs } from '../scripts/lib/klinik-gut-job-parser.mjs';
const body = 'Wir pflegen und begleiten unsere Patienten mit einem professionellen interdisziplinären Team. '.repeat(20);
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: date, jobStartDate: '2026-09-01', dateModified: '2026-09-02', validThrough: '2030-12-31' })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const dualoo = (portal: string, city: string) => `<a class="row jobElement" data-eventData="{&quot;startDate&quot;:&quot;2026-09-01&quot;}" href="${portal}/${uuid}/detail?lang=DE"><span class="jobName">Diplomierte Pflegefachperson</span><span class="cityName">${city}</span><span class="badge jobCategory">Pflege</span><span class="badge jobDate" data-date="2026-09-01">Nach Vereinbarung</span></a>`;
const profiles = [
  ['aadorf', fetchAllKlinikAadorfJobs, 'https://jobs.dualoo.com/portal/3ibnwlo9?lang=DE', dualoo('3ibnwlo9', 'Aadorf'), `<div class="advertisementDescriptionText"><p>${body}</p></div>`],
  ['arlesheim', fetchAllKlinikArlesheimJobs, 'https://jobs.dualoo.com/portal/s60emmh3?lang=DE', dualoo('s60emmh3', 'Arlesheim'), `<div class="advertisementDescriptionText"><p>${body}</p></div>`],
  ['adelheid', fetchAllKlinikAdelheidJobs, 'https://www.klinik-adelheid.ch/jobs-und-karriere/offene-stellen/', '<tr><td><a href="/job/pflege/">Pflegefachperson</a></td><td><a href="/job/pflege/">Pflege</a></td></tr>', `<p>Wir suchen nach Vereinbarung</p><p>${body}</p><h2>Online-Bewerbung</h2>`],
  ['barmelweid', fetchAllKlinikBarmelweidJobs, 'https://jobs.barmelweid.ch/offene-stellen', `<div class="hf-portrait" onclick="javascript:location.href='/pflege'"><h3>Pflegefachperson</h3><p>${body}</p><p>100%, 01.09.2026</p></div></div></div>`, `<div class="jobheader"><h1>Pflegefachperson</h1></div><div class="jobinfo"><p>${body}</p></div>`],
] as const;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'bad-date', ''], ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
for (const [name, producer, listingUrl, listingHtml, detailHtml] of profiles) {
  describe(`${name} detail publication with original fetch`, () => {
    it.each(cases)('%s', async (_, raw, expected) => {
      const fetcher = vi.fn(async (input: string | URL | Request) => new Response(urlOf(input) === listingUrl ? listingHtml : ld(raw) + detailHtml));
      vi.stubGlobal('fetch', fetcher);
      const jobs = await producer();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', crawledAt: '2026-10-04T12:00:00.000Z' });
      expect(jobs[0].description).toContain('interdisziplinären Team');
      expect(jobs[0].applyUrl).toMatch(/^https:\/\//);
      expect(jobs[0].id.length).toBeGreaterThan(5);
      expect(jobs[0].slug.length).toBeGreaterThan(5);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
}
describe('Klinik Gut per-vacancy accordion publication', () => {
  it.each(cases)('%s without borrowing page metadata', async (_, raw, expected) => {
    const fetcher = vi.fn(async () => new Response(`${ld('2026-09-01')}<a class="btn btn-primary" title="Klinik Gut Fläsch">Fläsch</a><button class="accordion-button" data-bs-target="#drz-accordion-id-123">Pflegefachperson</button><div id="drz-accordion-id-123"><div class="accordion-body">${ld(raw)}<p>${body}</p><p>Eintritt 01.09.2026</p></div></div>${ld('2026-09-03')}`));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllKlinikGutJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('interdisziplinären Team');
    expect(jobs[0].url).toContain('#drz-accordion-id-123');
    expect(jobs[0].applyUrl).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it('Gut isolates two neighbouring accordions and ignores later global metadata', async () => {
  const accordion = (id: number, date: unknown) => `<button class="accordion-button" data-bs-target="#drz-accordion-id-${id}">Pflegefachperson ${id}</button><div id="drz-accordion-id-${id}"><div class="accordion-body">${ld(date)}<p>${body}</p></div></div>`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(accordion(123, undefined) + accordion(124, '2026-09-02') + ld('2026-09-03'))));
  const jobs = await fetchAllKlinikGutJobs();
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  expect(jobs[1]).toMatchObject({ datePosted: '2026-09-02', postedDate: '2026-09-02', postingDateSource: 'reported' });
  expect(jobs.every(job => job.description.includes('interdisziplinären Team'))).toBe(true);
});
