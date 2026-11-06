import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKomaxGroupJobs } from '../scripts/lib/komax-group-job-parser.mjs';
import { fetchAllKuehneNagelJobs } from '../scripts/lib/kuehne-nagel-job-parser.mjs';
import { fetchAllLiebherrJobs } from '../scripts/lib/liebherr-job-parser.mjs';
import { fetchAllLocalsearchJobs } from '../scripts/lib/localsearch-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const localUrl = 'https://emp.jobylon.com/jobs/12345-technical-engineer/';
const providers = [
  { name: 'Komax', run: fetchAllKomaxGroupJobs, calls: 1, response: (_url: string, raw: string) => `<rss><channel><lastBuildDate>${past}</lastBuildDate><item><title>${title} (Dierikon, CH, 6036)</title><link>https://jobs.komaxgroup.com/job/Engineer/12345/</link><g:id>12345</g:id><g:location>Dierikon, CH, 6036</g:location><description><![CDATA[${body}]]></description><pubDate>${raw}</pubDate></item></channel></rss>` },
  { name: 'Kuehne', run: fetchAllKuehneNagelJobs, calls: 3, response: (url: string, raw: string) => url.includes('/widgets') ? JSON.stringify({ eagerLoadRefineSearch: { totalHits: 1, data: { jobs: [{ title, jobSeqNo: 'KUNAGLOBAL12345', city: 'Schindellegi', country: 'Switzerland', postedDate: raw, dateCreated: past }] } } }) : url.includes('/job/') ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, description: body, jobLocation: { address: { addressLocality: 'Schindellegi', addressCountry: 'CH' } } })}</script><script>var job = {"standardisedStateCode":"SZ"};</script>` : '{"csrfToken":"test-token"}' },
  { name: 'Liebherr', run: fetchAllLiebherrJobs, calls: 2, response: (url: string, raw: string) => url.includes('/job/') ? `<meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><div itemprop="description">${body}</div>` : `<ul><li class="job-tile job-id-12345" data-url="/job/Engineer/12345/"><a class="jobTitle-link">${title}</a><span class="section-location-value">Bulle, CH</span></li></ul>` },
  { name: 'Localsearch', run: fetchAllLocalsearchJobs, calls: 2, response: (url: string, raw: string, other = false, listingRaw = '') => url === localUrl ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url: other ? localUrl + 'other/' : localUrl, description: body, datePosted: raw, dateCreated: past })}</script>` : `JBL.embed_v2['jobs'] = ${JSON.stringify([{ title, url: '/jobs/12345-technical-engineer/', locations: ['Zürich'], language: 'en', published_date: listingRaw, summary: body }])};` },
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const provider of providers) {
  describe(`${provider.name} actual producer publication`, () => {
    it.each([['timestamp', past, past], ['missing other dates only', '', ''], ['invalid', invalid, ''], ['future', future, '']])('%s', async (_kind, raw, expected) => {
      const transport = vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(provider.calls);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each([['foreign detail', past, true, '', ''], ['invalid detail valid listing', invalid, false, past, past], ['future detail valid listing', future, false, past, past]])('Localsearch %s', async (_kind, raw, other, listingRaw, expected) => {
  const provider = providers[3];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), String(raw), Boolean(other), String(listingRaw)), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
});
