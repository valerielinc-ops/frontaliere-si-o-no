import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllEtatDeFribourgJobs } from '../scripts/lib/etat-de-fribourg-job-parser.mjs';
import { fetchAllEthZurichJobs } from '../scripts/lib/eth-zurich-job-parser.mjs';
import { fetchAllFhgrJobs } from '../scripts/lib/fhgr-job-parser.mjs';
import { fetchAllGoogleSwitzerlandJobs } from '../scripts/lib/google-switzerland-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const ethUrl = 'https://jobs.ethz.ch/job/view/12345';
const fhgrUrl = 'https://jobs.fhgr.ch/Vacancies/12345/Description/1';
const googleUrl = 'https://www.google.com/about/careers/applications/jobs/results/12345-technical-engineer';
const ld = (raw: string, url: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, description: body, datePosted: raw, dateCreated: past, dateModified: past, jobStartDate: past, validThrough: past })}</script>`;
const providers = [
  { name: 'Fribourg', run: fetchAllEtatDeFribourgJobs, requests: 2, response: (url: string, raw: string) => url.includes('/search/') ? `<ul><li class="job-tile job-id-12345 job-row-index-0" data-url="/job/Fribourg-Engineer/12345/" data-row-index="0"><div class="tiletitle"><a class="jobTitle-link" href="/job/Fribourg-Engineer/12345/">${title}</a></div><div id="job-12345-desktop-section-city-value">Fribourg, CH</div></li></ul>` : `<html lang="fr"><span data-careersite-propertyid="title">${title}</span><div data-careersite-propertyid="description">${body}</div><meta itemprop="addressLocality" content="Fribourg"><meta itemprop="addressCountry" content="CH"><meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"></html>` },
  { name: 'ETH', run: fetchAllEthZurichJobs, requests: 2, response: (url: string, raw: string, other = false) => url === ethUrl ? `${ld(raw, other ? ethUrl + '-other' : ethUrl)}<main><h1>${title}</h1><p>${body}</p></main>` : `<a class="job-ad__item__link" href="${ethUrl}" aria-label="${title} - 100%, Zürich, Permanent"></a>` },
  { name: 'FHGR', run: fetchAllFhgrJobs, requests: 2, response: (url: string, raw: string, other = false) => url === fhgrUrl ? `${ld(raw, other ? fhgrUrl.replace('12345', '99999') : fhgrUrl)}<h1>${title}</h1><div class="text" id="einschub">${body}</div>` : `<table><tr class="tableaslist_contentrow1"><td class="tableaslist_element_1152488"><a href="/Vacancies/12345/Description/1">${title}</a></td><td class="tableaslist_element_1152495"><span>Chur</span></td></tr></table>` },
  { name: 'Google', run: fetchAllGoogleSwitzerlandJobs, requests: 3, response: (url: string, raw: string, other = false) => url === googleUrl ? `${ld(raw, other ? googleUrl + '-other' : googleUrl)}<h3>Minimum qualifications</h3><p>${body}</p>` : url.includes('page=1') ? `<h3>${title}</h3><p>Google | Zürich, Switzerland</p><a href="${googleUrl}" aria-label="Learn more about ${title}">Learn more</a><div>Showing 1 to 1 of 1 rows</div>` : '<html></html>' },
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const provider of providers) {
  describe(`${provider.name} real producer publication`, () => {
    it.each([['timestamp', past, past], ['missing other dates only', '', ''], ['invalid', invalid, ''], ['future', future, '']])('%s', async (_kind, raw, expected) => {
      const transport = vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(provider.requests);
      const tuple = { postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple);
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers.filter(provider => provider.name !== 'Fribourg'))('$name rejects same-title foreign URL', async (provider) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
it('Google Jina body fallback does not invent publication when direct HTML has none', async () => {
  const provider = providers[3];
  const transport = vi.fn(async (url: unknown) => {
    const href = String(url);
    return new Response(href.startsWith('https://r.jina.ai/') ? `Markdown Content:\n${body}` : href === googleUrl ? '<html></html>' : provider.response(href, ''), { status: 200 });
  });
  vi.stubGlobal('fetch', transport);
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
  expect(transport).toHaveBeenCalledTimes(4);
});
