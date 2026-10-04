import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllRiveneuveJobs } from '../scripts/lib/riveneuve-job-parser.mjs';
import { fetchAllRsbjJobs } from '../scripts/lib/rsbj-job-parser.mjs';
import { fetchAllRssSurselvaJobs, parseOstendisJob } from '../scripts/lib/rss-surselva-job-parser.mjs';
import { fetchAllSolinaJobs } from '../scripts/lib/solina-job-parser.mjs';
import { fetchAllSonnweidJobs } from '../scripts/lib/sonnweid-job-parser.mjs';
const body = 'Il personale infermieristico assicura cure professionali alle persone accolte nella struttura. '.repeat(20);
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', datePosted: '2026-09-01' }, { '@type': 'JobPosting', datePosted: date, description: body, jobStartDate: '2026-09-02', validThrough: '2030-12-31' }] })}</script>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
  ['missing', undefined, ''], ['invalid', 'bad-date', ''], ['future', '2030-01-01', ''], ['invalid calendar', '2026-02-30', ''],
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const profiles = [
  ['riveneuve', fetchAllRiveneuveJobs, 'https://www.riveneuve.ch/jcms/rivd_7358/fr/emplois', '<div class="article-title"><a class="card-link" href="jcms/rivd_123/fr/infirmier">Infirmier diplômé</a></div>', `<h1 class="publication-title">Infirmier diplômé</h1><div class="wysiwyg">${body}</div>`, 2],
  ['rsbj', fetchAllRsbjJobs, 'https://www.rsbj.ch/jcms/rsbj_8733/fr/nos-offres-d-emplois', '<a href="jcms/rsbj_123/fr/infirmier" class="vignette-a" data-jalios-id=\'rsbj_123\'><div class="title">Infirmier diplômé<br>CDI100%</div></a>', `<div class="fullDisplay"><div class="publication-metas">Date entrée01.09.2026</div><div class="wysiwyg">${body}</div></div>`, 2],
  ['solina', fetchAllSolinaJobs, 'https://jobs.solina.ch/offene-stellen/pflege-betreuung', '<a href="/offene-stellen/pflege-betreuung/pflege-abc123">Pflegefachperson</a>', `<title>Pflegefachperson | Solina</title><h1>Pflegefachperson</h1><main><p>${body}</p><a href="https://stiftung-solina.onlyfy.jobs/application/example">Bewerben</a></main>`, 5],
  ['sonnweid', fetchAllSonnweidJobs, 'https://www.sonnweid.ch/karriere/offene-stellen/', '<a href="https://www.sonnweid.ch/karriere/job/pflege" class="jobItem"><div class="jobItemTitle">Pflegefachperson</div><div class="jobItemEintritt">Eintritt:01.09.2026</div></a>', `<main><p>${body}</p></main>`, 2],
] as const;
for (const [name, producer, listingUrl, listingHtml, detailHtml, requestCount] of profiles) describe(`${name} keeps original publication from same detail fetch`, () => {
  it.each(cases)('%s', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url === listingUrl) return new Response(listingHtml);
      if (name === 'solina' && !url.endsWith('/pflege-abc123')) return new Response('');
      return new Response(ld(raw) + detailHtml);
    });
    vi.stubGlobal('fetch', fetcher);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(jobs[0].applyUrl).toMatch(/^https:\/\//);
    expect(jobs[0].slug.length).toBeGreaterThan(4);
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
  });
});
describe('RSS Surselva real Ostendis API and detail pipeline', () => {
  it.each(cases)('%s ignores generic API timestamp and preserves body', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('/ojp/data/')
      ? Response.json({ jobs: [{ id: 123, title: 'Pflegefachperson', city: 'Ilanz', zip: '7130', countrycode: 'CH', detail: 'https://link.ostendis.com/publication/pflege/123', action: 'https://link.ostendis.com/cvdropper/123/DE', timestamp: '2026-09-01' }] })
      : new Response(ld(raw)));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await fetchAllRssSurselvaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', applyUrl: 'https://link.ostendis.com/cvdropper/123/DE' });
    expect(jobs[0].description).toContain('cure professionali');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not promote an unmarked legacy detail alias', () => {
    const job = parseOstendisJob({ id: 123, title: 'Pflegefachperson', city: 'Ilanz' }, { description: body, datePosted: '2026-09-01' });
    expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(job.description).toContain('cure professionali');
  });
});
