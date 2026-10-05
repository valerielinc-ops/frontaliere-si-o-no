import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllRiriJobs } from '../scripts/lib/riri-job-parser.mjs';
import { fetchAllRolexJobs } from '../scripts/lib/rolex-job-parser.mjs';
import { fetchAllSfsGroupJobs } from '../scripts/lib/sfs-group-job-parser.mjs';
import { fetchAllSonovaJobs } from '../scripts/lib/sonova-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const sfsUrl = 'https://join.sfs.com/ch/en/vacancies/technical-engineer.jsp';
const providers = [
  { name: 'Riri', run: fetchAllRiriJobs, calls: 1, response: (_url: string, raw: string) => `<rss><channel><lastBuildDate>${past}</lastBuildDate><item><title>${title} (Mendrisio, TI, CH, 6850)</title><link>https://careers.oerlikon.com/job/Engineer/12345/</link><guid>12345</guid><description><![CDATA[${body}]]></description><pubDate>${raw}</pubDate></item></channel></rss>` },
  { name: 'Rolex', run: fetchAllRolexJobs, calls: 2, response: (url: string, raw: string) => url.includes('/Rolex/job/') ? `<meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><meta itemprop="addressCountry" content="CH"><meta itemprop="addressLocality" content="Genève"><div itemprop="description">${body}</div>` : `<table><tr class="data-row"><td><a class="jobTitle-link" href="/Rolex/job/Engineer/12345/">${title}</a></td></tr></table>` },
  { name: 'SFS', run: fetchAllSfsGroupJobs, calls: 2, response: (url: string, raw: string, other = false) => url === sfsUrl ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url: other ? sfsUrl + '-other' : sfsUrl, datePosted: raw, dateCreated: past })}</script><div class="organism-text"><div class="text">${body}</div></div>` : `<a class="molecule-responsive-datalist-entry values-are-copytext" href="/ch/en/vacancies/technical-engineer.jsp"><span class="column-value">${title}</span><span class="column-value">Heerbrugg, Schweiz</span><span class="column-value">SFS</span></a>` },
  { name: 'Sonova', run: fetchAllSonovaJobs, calls: 2, response: (url: string, raw: string) => url.includes('/job/') ? `<meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><span class="jobdescription">${body}</span>` : `<li data-url="/job/Engineer/12345/"><a class="jobTitle-link">${title}</a><div id="job-12345-location-value">Staefa, Switzerland</div></li>` },
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
it('SFS rejects same-title foreign URL publication', async () => {
  const provider = providers[2];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
it.each(providers.filter(provider => ['Rolex', 'Sonova'].includes(provider.name)))('$name preserves Java SF timestamp', async (provider) => {
  const date = new Date(Date.now() - 7 * 86400000); const day = date.toISOString().slice(0, 10);
  const raw = `${date.toUTCString().slice(0, 3)} ${date.toUTCString().slice(8, 11)} ${String(date.getUTCDate()).padStart(2, '0')} 00:15:00 +0200 ${date.getUTCFullYear()}`;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: `${day}T00:15:00+02:00`, postedDate: `${day}T00:15:00+02:00`, postingDateSource: 'reported' });
});
