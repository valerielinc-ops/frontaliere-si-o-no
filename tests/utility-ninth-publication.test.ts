import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllSodexoJobs } from '../scripts/lib/sodexo-job-parser.mjs';
import { fetchAllSomediaJobs } from '../scripts/lib/somedia-job-parser.mjs';
import { fetchAllSpitalLachenJobs } from '../scripts/lib/spital-lachen-job-parser.mjs';

const title = 'Fachperson Betreuung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const [name, producer] of [['Sodexo', fetchAllSodexoJobs], ['Somedia', fetchAllSomediaJobs]] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future', 'foreign-url', 'foreign-sameas', 'ambiguous', 'url-less', 'other-title', 'malformed-url']) {
    it(`${name}: same vacancy publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = kind === 'missing' ? undefined : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : `${year}-06-15T13:00:00+02:00`;
      const url = name === 'Sodexo' ? 'https://sodexo.concludis.de/prj/shw/fixture.htm' : 'https://jobs.somedia.ch/fixture-de-j123.html';
      const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Anderer Beruf' : title, description: body, datePosted: raw, url: ['ambiguous', 'url-less'].includes(kind) ? undefined : kind === 'foreign-url' ? 'https://wrong.example/job' : kind === 'malformed-url' ? 'http://[' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/job' : undefined, jobLocation: { address: { addressLocality: 'Chur', addressCountry: 'CH' } } };
      const detail = `<h1>${title}</h1><script type="application/ld+json">${JSON.stringify(posting)}</script>${kind === 'ambiguous' ? `<script type="application/ld+json">${JSON.stringify({ ...posting, datePosted: `${year}-01-01` })}</script>` : ''}`;
      const listing = name === 'Sodexo' ? `<div onclick="cJobboard.openJob('${url}');"><span class="headerlink stellenlink">${title}</span><span class="kurzb">Stellennummer 123 am Standort Chur - Vollzeit</span></div>` : `<a href="${url}">${title}</a>`;
      const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : listing, { status: 200 }));
      vi.stubGlobal('fetch', transport); const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(['valid', 'url-less'].includes(kind) ? { datePosted: raw, postedDate: raw!.slice(0, 10), postingDateSource: 'reported' } : unknown);
      expect(jobs[0].url).toBe(url); expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].crawledAt).toBeTruthy();
      expect(transport).toHaveBeenCalledTimes(2);
    });
  }
}
for (const kind of ['gmt', 'local-day', 'modified-only', 'invalid', 'future']) {
  it(`Lachen: WordPress publication, never modification ${kind}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const date = kind === 'gmt' || kind === 'local-day' ? `${year}-06-15T13:00:00` : kind === 'invalid' ? `${year}-02-30T13:00:00` : kind === 'future' ? `${year + 2}-06-15T13:00:00` : undefined;
    const url = 'https://spital-lachen.ch/jobs/fixture/';
    const row = { id: 1, title: { rendered: title }, link: url, date: kind === 'local-day' ? date : undefined, date_gmt: kind !== 'local-day' ? date : undefined, modified: `${year}-06-16T13:00:00`, modified_gmt: `${year}-06-16T13:00:00` };
    const detail = `<h3 class="accordion__title text-medium">Ihre Aufgaben</h3><div class="accordion__content js-accordion-content text-regular"><p>${body}</p></div><p class="hero__description">${body}</p>`;
    const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input).includes('/wp-json/') ? JSON.stringify([row]) : detail, { status: 200 }));
    vi.stubGlobal('fetch', transport); const pending = fetchAllSpitalLachenJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    const expected = kind === 'gmt' ? `${date}Z` : kind === 'local-day' ? `${year}-06-15` : '';
    expect(jobs[0]).toMatchObject(expected ? { datePosted: expected, postedDate: expected.slice(0, 10), postingDateSource: 'reported' } : unknown);
    expect(jobs[0].url).toBe(url); expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].crawledAt).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(2); expect(String(transport.mock.calls[0][0])).toContain('date_gmt');
  });
}
