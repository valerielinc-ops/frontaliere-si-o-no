import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
const browserTransport = vi.hoisted(() => ({ html: (_url: string) => '', calls: [] as string[], closes: 0 }));
vi.mock('../scripts/lib/ats-clients/playwright-runtime.mjs', () => ({
  createBrowser: async () => ({}), createPoliteContext: async () => ({}), closeAll: async () => {},
  AntiBotBlockError: class extends Error {}, NavigationTimeout: class extends Error {},
  fetchWithRateLimit: async (_context: unknown, url: string) => {
    browserTransport.calls.push(url);
    return { content: async () => browserTransport.html(url), waitForSelector: async () => {}, close: async () => { browserTransport.closes += 1; },
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        const dom = new JSDOM(browserTransport.html(url));
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        vi.stubGlobal('document', dom.window.document);
        try { return fn(arg); } finally { dom.window.close(); }
      },
    };
  },
}));
import { fetchAllPlanzerJobs } from '../scripts/lib/planzer-job-parser.mjs';
import { fetchAllRichemontJobs } from '../scripts/lib/richemont-job-parser.mjs';
import { fetchAllRicolaJobs } from '../scripts/lib/ricola-job-parser.mjs';
import { fetchAllRieterJobs } from '../scripts/lib/rieter-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const planzerUrl = 'https://live.solique.ch/planzer/job/technical-engineer/12345';
const richemontUrl = 'https://careers.richemont.com/en/jobs/jr12345/technical-engineer/';
const ricolaUrl = 'https://career.ricola.com/Vacancies/12345/Description/2';
const rieterUrl = 'https://live.solique.ch/rieter/jobs/technical-engineer--12345';
const ld = (raw: string, url: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, description: body, datePosted: raw, dateCreated: past, dateModified: past, jobStartDate: past })}</script>`;
const providers = [
  { name: 'Planzer', run: fetchAllPlanzerJobs, calls: 2, response: (url: string, raw: string, other = false) => url === planzerUrl ? `${ld(raw, other ? planzerUrl + '-other' : planzerUrl)}<div class="intro">${body}</div>` : `<div class="job"><a id="12345" href="${planzerUrl}"><div class="jobtitle">${title}</div><div class="location">Dietikon</div><div class="workload">100%</div></a></div>` },
  { name: 'Richemont', run: fetchAllRichemontJobs, calls: 2, response: (url: string, raw: string, other = false) => url === richemontUrl ? `${ld(raw, other ? richemontUrl + 'other/' : richemontUrl)}<div class="job-detail"><div class="cms-content">${body}</div></div>` : `<div class="card card-job" data-id="jr12345"><h2 class="card-title">${title}</h2><a class="stretched-link" href="${richemontUrl}">View</a><ul class="job-meta"><li>Richemont</li><li>Engineering</li><li>Geneva, CH</li></ul></div>` },
  { name: 'Ricola', run: fetchAllRicolaJobs, calls: 3, response: (url: string, raw: string, other = false) => url === ricolaUrl ? `${ld(raw, other ? ricolaUrl + '-other' : ricolaUrl)}<h1>${title}</h1><p>${body}</p>` : `<table><tr class="tableaslist_contentrow1"><td><a href="/Vacancies/12345/Description/2">${title}</a> | Laufen</td></tr></table>` },
  { name: 'Rieter', run: fetchAllRieterJobs, calls: 2, response: (url: string, raw: string, other = false) => url === rieterUrl ? `${ld(raw, other ? rieterUrl + '-other' : rieterUrl)}<div class="text">${body}</div>` : `<div class="job"><div class="job-title"><a href="${rieterUrl}">${title}</a></div><div class="job-location">Winterthur</div><div class="job-country">Switzerland</div></div>` },
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
      if (provider.name === 'Richemont') { expect(transport).not.toHaveBeenCalled(); expect(browserTransport.calls).toHaveLength(2); expect(browserTransport.closes).toBe(2); }
      else expect(transport).toHaveBeenCalledTimes(provider.calls);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers)('$name rejects same-title foreign URL publication', async (provider) => {
  browserTransport.html = url => provider.response(url, past, true);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
