import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllBarryCallebautJobs } from '../scripts/lib/barry-callebaut-job-parser.mjs';
import { fetchAllBcvJobs } from '../scripts/lib/bcv-job-parser.mjs';
import { fetchAllBelimoJobs } from '../scripts/lib/belimo-job-parser.mjs';
import { fetchAllBentelerJobs } from '../scripts/lib/benteler-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const pastDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const past = `${pastDay}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const providers = [
  { name: 'Barry Callebaut', run: fetchAllBarryCallebautJobs, listing: (raw: string) => `<rss><channel><item><title>Technical Engineer</title><description><![CDATA[${body}]]></description><link>https://jobs.barry-callebaut.com/job/Zurich-Engineer/12345/</link><g:id>12345</g:id><g:location>Zurich, CH, 8005</g:location><pubDate>${raw}</pubDate><g:expiration_date>${past}</g:expiration_date><lastBuildDate>${past}</lastBuildDate></item></channel></rss>`, requests: 1 },
  { name: 'BCV', run: fetchAllBcvJobs, listing: () => `<urlset><url><loc>https://jobs.bcv.ch/job/Lausanne-Engineer/12345/</loc><lastmod>${past}</lastmod></url></urlset>`, requests: 2 },
  { name: 'Belimo', run: fetchAllBelimoJobs, listing: () => '<urlset><url><loc>https://jobsredirect.belimo.com/job/Hinwil-Engineer-8340/9999999/</loc></url></urlset>', requests: 2 },
  { name: 'Benteler', run: fetchAllBentelerJobs, listing: () => '<table><tr class="data-row"><td><a href="/job/Zug-Engineer/12345/" class="jobTitle-link">Technical Engineer</a><span class="jobLocation">Zug, CH</span></td></tr></table>', requests: 2 },
];

function detail(raw: string) {
  return `<html><h1 itemprop="title">Technical Engineer</h1><span itemprop="title">Technical Engineer</span><meta itemprop="addressCountry" content="CH"><meta itemprop="addressLocality" content="Hinwil"><meta itemprop="postalCode" content="8340"><meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><meta itemprop="dateCreated" content="${past}"><meta itemprop="jobStartDate" content="${past}"><div itemprop="description">${body}</div><div><span itemprop="description">${body}</span></div><span class="jobdescription">${body}</span><p class="job-location"></p></html>`;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const provider of providers) {
  describe(`${provider.name}: actual producer and DCC merge`, () => {
    // The RSS pubDate positive is a supported input contract, not proof that the current feed contains it.
    it.each([['timestamp', past, past], ['missing with non-publication dates', '', ''], ['invalid calendar', invalid, ''], ['future', future, '']])('%s', async (_label, raw, expected) => {
      let calls = 0;
      const fetchMock = vi.fn(async () => new Response(++calls === 1 ? provider.listing(raw) : detail(raw), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(provider.requests);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple);
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject(tuple);
    });
  });
}

it.each(providers)('$name preserves a provider-formatted full timestamp', async (provider) => {
  const date = new Date(Date.now() - 7 * 86400000); date.setUTCMilliseconds(0);
  const rss = date.toUTCString();
  const words = rss.replace(',', '').split(' ');
  const java = `${words[0]} ${words[2]} ${words[1]} ${words[4]} UTC ${words[3]}`;
  const raw = provider.name === 'Barry Callebaut' ? rss : java;
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(++calls === 1 ? provider.listing(raw) : detail(raw), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: date.toISOString().replace('.000Z', 'Z'), datePosted: date.toISOString().replace('.000Z', 'Z'), postingDateSource: 'reported' });
});
