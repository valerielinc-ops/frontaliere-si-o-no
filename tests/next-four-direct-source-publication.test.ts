import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllBlsJobs } from '../scripts/lib/bls-job-parser.mjs';
import { fetchAllBmsBuildingJobs } from '../scripts/lib/bms-building-job-parser.mjs';
import { fetchAllChiccoDoroJobs } from '../scripts/lib/chicco-doro-job-parser.mjs';
import { fetchAllClariantJobs } from '../scripts/lib/clariant-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const ld = (raw: string, url: string, recordTitle = title) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: recordTitle, url, description: body, datePosted: raw, dateCreated: past, dateModified: past, validThrough: past, jobStartDate: past, jobLocation: { address: { addressLocality: 'Bern', addressCountry: 'CH' } } })}</script>`;
const blsUrl = 'https://jobs.bls.ch/offene-stellen/technical-engineer/12345';
const bmsUrl = 'https://jobs.bmsuisse.ch/jobs/detail/12345-technical-engineer/';
const chiccoUrl = 'https://www.chiccodoro.com/jobs/technical-engineer';
const providers = [
  { name: 'BLS', run: fetchAllBlsJobs, requests: 3, response: (url: string, raw: string, other = false) => /JobsSearch|JobsInit/.test(url) ? JSON.stringify([{ Title: title, Lead: 'Bern, 80-100%', URL: blsUrl }]) : url === blsUrl ? ld(raw, blsUrl, other ? 'Another vacancy' : title) : '<html></html>' },
  { name: 'BMS', run: fetchAllBmsBuildingJobs, requests: 2, response: (url: string, raw: string, other = false) => url.includes('/jobs/detail/') ? `<h1>${title}</h1><div class="tx-webx-jobs"><div class="details"><h2 class="job-title">${title}</h2><p>${body}</p></div></div>${ld(raw, other ? bmsUrl.replace('12345', '99999') : bmsUrl, other ? 'Another vacancy' : title)}` : `<a href="/jobs/detail/12345-technical-engineer/">${title}</a><span>3000 Bern</span>` },
  { name: 'Chicco', run: fetchAllChiccoDoroJobs, requests: 4, response: (url: string, raw: string, other = false) => url === chiccoUrl ? `<title>Chicco d'Oro</title><main><h1>${title}</h1><p>${body}</p></main>${ld(raw, other ? chiccoUrl + '-other' : chiccoUrl, other ? 'Another vacancy' : title)}` : `<title>Chicco d'Oro</title><main><div class="job-card"><h2><a href="${chiccoUrl}">${title}</a></h2><p>${body}</p></div></main>` },
  { name: 'Clariant', run: fetchAllClariantJobs, requests: 2, response: (url: string, raw: string) => url.includes('/job/Pratteln-Engineer/') ? `<meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><meta itemprop="jobStartDate" content="${past}"><span class="jobdescription">${body}</span>` : `<table><tr class="data-row"><td><a href="/job/Pratteln-Engineer/12345/" class="jobTitle-link">${title}</a></td><td class="colLocation"><span class="jobLocation">Pratteln, CH</span></td></tr></table>` },
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const provider of providers) {
  describe(`${provider.name} actual producer publication`, () => {
    it.each([['timestamp', past, past], ['missing with other dates', '', ''], ['invalid calendar', invalid, ''], ['future', future, '']])('%s', async (_kind, raw, expected) => {
      const transport = vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(transport).toHaveBeenCalledTimes(provider.requests);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple);
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers.filter(provider => provider.name !== 'Clariant'))('$name does not borrow publication from another structured vacancy', async (provider) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it('BMS rejects a different explicit job URL even when its title matches', async () => {
  const provider = providers.find(provider => provider.name === 'BMS')!;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true).replaceAll('Another vacancy', title), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it('BMS requires independent DOM title before trusting a URL-less singleton', async () => {
  const provider = providers.find(provider => provider.name === 'BMS')!;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    let html = provider.response(String(url), past);
    if (String(url).includes('/jobs/detail/')) html = html.replace(`<h2 class="job-title">${title}</h2>`, '').replace(`"url":"${bmsUrl}",`, '');
    return new Response(html, { status: 200 });
  }));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it.each(['BLS', 'Chicco'])('%s rejects explicit foreign URL despite an identical title', async (name) => {
  const provider = providers.find(provider => provider.name === name)!;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    let html = provider.response(String(url), past, true).replaceAll('Another vacancy', title);
    if (name === 'BLS' && String(url) === blsUrl) html = html.replace(`"url":"${blsUrl}"`, `"url":"${blsUrl}-other"`);
    return new Response(html, { status: 200 });
  }));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
it('Chicco listing cannot lend a foreign URL singleton date to a same-title card', async () => {
  const provider = providers.find(provider => provider.name === 'Chicco')!;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const html = provider.response(String(url), '');
    return new Response(String(url) === chiccoUrl ? html : html + ld(past, chiccoUrl + '-other'), { status: 200 });
  }));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
