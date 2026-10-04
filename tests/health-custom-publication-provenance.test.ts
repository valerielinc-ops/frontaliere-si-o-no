import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllChamSwissPropertiesJobs } from '../scripts/lib/cham-swiss-properties-job-parser.mjs';
import { fetchAllCityPopJobs } from '../scripts/lib/city-pop-job-parser.mjs';
import { fetchAllDicSaJobs } from '../scripts/lib/dic-sa-job-parser.mjs';

const now = new Date();
const past = new Date(now.getTime() - 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const future = new Date(now.getTime() + 7 * 86400000).toISOString();
const body = 'Professionelle Betreuung unserer Projekte und Zusammenarbeit mit dem erfahrenen Team. '.repeat(6);
const portal = `<a class="jobElement" data-eventData="{&quot;startDate&quot;:&quot;ab sofort&quot;,&quot;location&quot;:&quot;Cham&quot;}" href="6j9quii0/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE"><span class="jobName">Projektleiter 80-100%</span></a>`;
const ld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: date, validThrough: past, description: body })}</script>`;
const response = (payload: unknown, html = false) => new Response(html ? String(payload) : JSON.stringify(payload), { status: 200, headers: { 'content-type': html ? 'text/html' : 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', past, past], ['missing', undefined, ''], ['invalid', 'not-a-date', ''],
  ['future', future, ''], ['invalid calendar', `${now.getUTCFullYear() - 1}-02-30`, ''],
];

for (const source of ['cham', 'citypop', 'dic'] as const) {
  describe(`${source} real producer publication evidence`, () => {
    it.each(cases)('%s retains the available job and the strict date tuple', async (_name, raw, expected) => {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (source === 'cham') return response(url.includes('/detail') ? `${ld(raw)}<div class="advertisementResponsibilitiesText">${body}</div>` : portal, true);
        if (source === 'citypop') return url.includes('job-search-api')
          ? response({ numPages: 1, documents: [{ id: 'test-posting', title: 'Projektleiter', place: 'Zürich', publicationDate: past, initialPublicationDate: past }] })
          : response(ld(raw), true);
        return response([{ id: 42, title: { rendered: 'Ingenieur civil' }, content: { rendered: body }, link: 'https://www.dic-ing.ch/job-offers/ingenieur/', date_gmt: raw, modified_gmt: past, starting_date: past }]);
      });
      vi.stubGlobal('fetch', fetchMock);
      const jobs = await (source === 'cham' ? fetchAllChamSwissPropertiesJobs() : source === 'citypop' ? fetchAllCityPopJobs() : fetchAllDicSaJobs());
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
      expect(job.description).toContain('Professionelle Betreuung');
      expect(job.url).toMatch(/^https:\/\//); expect(job.applyUrl).toMatch(/^https:\/\//);
      expect(job.id).toBeTruthy(); expect(job.slug).toBeTruthy();
      expect(Date.parse(job.crawledAt)).toBe(now.getTime());
      expect(fetchMock).toHaveBeenCalledTimes(source === 'dic' ? 1 : 2);
      if (source === 'cham') expect(job.description).toContain('ab sofort');
    });
  });
}

describe('DIC WordPress publication timezones', () => {
  it.each([
    ['GMT is explicit in the API contract', past.replace(/Z$/, ''), undefined, past],
    ['valid zoned local publication survives invalid GMT', 'invalid', past, past],
    ['timezone-less local publication is not assigned an invented offset', undefined, past.replace(/Z$/, ''), ''],
  ] as const)('%s', async (_name, gmt, local, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{ id: 42, title: { rendered: 'Ingenieur civil' }, content: { rendered: body }, link: 'https://www.dic-ing.ch/job-offers/ingenieur/', date_gmt: gmt, date: local, modified_gmt: past }])));
    const [job] = await fetchAllDicSaJobs();
    expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(job.description).toContain('Professionelle Betreuung');
  });
});
