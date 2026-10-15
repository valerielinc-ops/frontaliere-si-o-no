import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const browserTransport = vi.hoisted(() => ({ html: (_url: string) => '', calls: [] as string[], closes: 0 }));
vi.mock('../scripts/lib/ats-clients/playwright-runtime.mjs', () => ({
  createBrowser: async () => ({}), createPoliteContext: async () => ({}), closeAll: async () => {},
  BrowserLaunchError: class extends Error {}, NavigationTimeout: class extends Error {}, AntiBotBlockError: class extends Error {},
  fetchWithRateLimit: async (_context: unknown, url: string) => {
    browserTransport.calls.push(url);
    return { content: async () => browserTransport.html(url), url: () => url, waitForLoadState: async () => {}, close: async () => { browserTransport.closes += 1; } };
  },
}));
import { fetchAllHessCarrosserieJobs } from '../scripts/lib/hess-carrosserie-job-parser.mjs';
import { fetchAllHolcimJobs } from '../scripts/lib/holcim-job-parser.mjs';
import { fetchAllHolmesPlaceJobs } from '../scripts/lib/holmes-place-job-parser.mjs';
import { fetchAllHoneggerJobs } from '../scripts/lib/honegger-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const hessUrl = 'https://jobs.hess-ag.ch/publication/technical-engineer/12345';
const holmesUrl = 'https://www.holmesplace.ch/jobs/technical-engineer/';
const honeggerUrl = 'https://honegger.ch/job/technical-engineer/';
const ld = (raw: string, url: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, description: body, datePosted: raw, dateCreated: past, dateModified: past, validThrough: past, jobStartDate: past })}</script>`;
const providers = [
  { name: 'Hess', run: fetchAllHessCarrosserieJobs, response: (url: string, raw: string, other = false) => url === hessUrl ? ld(raw, other ? hessUrl + '-other' : hessUrl) : JSON.stringify({ jobs: [{ title, countrycode: 'CH', city: 'Bellach', detail: hessUrl, timestamp: Math.floor(Date.now() / 1000) - 86400 }] }) },
  { name: 'Holcim', run: fetchAllHolcimJobs, response: (url: string, raw: string) => url.includes('/job/Zurich-Engineer/') ? `<meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><span class="jobdescription">${body}</span>` : `<a class="jobTitle-link" href="/job/Zurich-Engineer/12345/">${title}</a><div id="job-12345-multilocation-value">Zurich, CH</div>` },
  { name: 'Holmes', run: fetchAllHolmesPlaceJobs, response: (url: string, raw: string, other = false) => url === holmesUrl ? `${ld(raw, other ? holmesUrl + 'other/' : holmesUrl)}<main class="job-detail"><h1>${title}</h1><div class="job-detail__description">${body}</div></main>` : `<section class="career-list"><article class="career-card"><div class="location">Lausanne</div><h2>${title}</h2><a href="${holmesUrl}">Mehr erfahren</a></article></section>` },
  { name: 'Honegger', run: fetchAllHoneggerJobs, response: (url: string, raw: string) => url === honeggerUrl ? `<h2 class="wp-block-heading has-deepwhite-color has-text-color has-xx-large-font-size">${title}</h2><meta property="article:published_time" content="${raw}"><meta property="article:modified_time" content="${past}"><div class="taxonomy-standorte"><a href="https://honegger.ch/standort/sarnen/">Sarnen</a></div><h2 class="wp-block-heading">Das kannst du bei uns bewirken</h2><ul class="wp-block-list hon-list"><li>${body}</li></ul>` : `<ul><li class="wp-block-post post-12345 jobs type-jobs"><h2 class="wp-block-post-title">${title}</h2><a class="wp-block-post-excerpt__more-link" href="${honeggerUrl}">Mehr erfahren</a></li></ul>` },
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); browserTransport.calls = []; browserTransport.closes = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const provider of providers) {
  describe(`${provider.name} actual producer publication`, () => {
    it.each([['timestamp', past, past], ['missing other dates only', '', ''], ['invalid', invalid, ''], ['future', future, '']])('%s', async (_kind, raw, expected) => {
      browserTransport.html = url => provider.response(url, raw);
      const transport = vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      if (provider.name === 'Holmes') { expect(transport).not.toHaveBeenCalled(); expect(browserTransport.calls).toHaveLength(2); expect(browserTransport.closes).toBe(2); }
      else expect(transport).toHaveBeenCalledTimes(2);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers.filter(provider => ['Hess', 'Holmes'].includes(provider.name)))('$name rejects same-title foreign URL publication', async (provider) => {
  browserTransport.html = url => provider.response(url, past, true);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
