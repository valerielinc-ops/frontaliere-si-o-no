import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllMatterhornGotthardBahnJobs } from '../scripts/lib/matterhorn-gotthard-bahn-job-parser.mjs';
import { fetchAllMicrosoftJobs } from '../scripts/lib/microsoft-job-parser.mjs';
import { fetchAllMistralAiJobs } from '../scripts/lib/mistral-ai-job-parser.mjs';
import { fetchAllMobiliarJobs } from '../scripts/lib/mobiliar-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const mgbUrl = 'https://jobs.bvzholding.ch/technical-engineer-de-j12345.html';
const mobiliarUrl = 'https://jobs.mobiliar.ch/job/Bern-Engineer/12345/';
const ld = (raw: string, url: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, description: body, datePosted: raw, dateCreated: past, validThrough: past, jobLocation: { address: { addressLocality: 'Brig', addressCountry: 'CH' } } })}</script>`;
const providers = [
  { name: 'MGB', run: fetchAllMatterhornGotthardBahnJobs, response: (url: string, raw: string, other = false) => url === mgbUrl ? ld(raw, other ? mgbUrl + '-other' : mgbUrl) : `<a href="${mgbUrl}">${title}</a>` },
  { name: 'Microsoft', run: fetchAllMicrosoftJobs, response: (url: string, raw: string) => {
    if (url.includes('/careers?domain=')) return '<html></html>';
    if (url.includes('position_details')) return JSON.stringify({ data: { jobDescription: body } });
    const first = url.includes('location=Switzerland&') && url.includes('start=0');
    const postedTs = raw === invalid ? 'not-a-number' : raw ? Date.parse(raw) / 1000 : undefined;
    return JSON.stringify({ data: { count: first ? 1 : 0, positions: first ? [{ id: '12345', name: title, displayJobId: '200012345', standardizedLocations: ['Zürich, ZH, CH'], postedTs, creationTs: Date.parse(past) / 1000 }] : [] } });
  } },
  { name: 'Mistral', run: fetchAllMistralAiJobs, response: (_url: string, raw: string) => JSON.stringify({ jobs: [{ id: '12345', title, location: 'Zurich', jobUrl: 'https://jobs.ashbyhq.com/mistral/12345', publishedAt: raw, createdAt: past, descriptionHtml: body }] }) },
  { name: 'Mobiliar', run: fetchAllMobiliarJobs, response: (url: string, raw: string, other = false) => url === mobiliarUrl ? `${ld(raw, other ? mobiliarUrl + 'other/' : mobiliarUrl)}<h1>${title}</h1><h2>Das bringst du mit</h2><p>${body}</p>` : `<urlset><url><loc>${mobiliarUrl}</loc><lastmod>${past}</lastmod></url></urlset>` },
];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const provider of providers) {
  describe(`${provider.name} actual producer publication`, () => {
    it.each([['timestamp', past, past], ['missing other dates only', '', ''], ['invalid', invalid, ''], ['future', future, '']])('%s', async (_kind, raw, expected) => {
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200, headers: { 'x-csrf-token': 'test-token' } })));
      const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      const wanted = provider.name === 'Microsoft' && expected ? new Date(expected).toISOString() : expected;
      const tuple = { postedDate: wanted, datePosted: wanted, postingDateSource: wanted ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers.filter(provider => ['MGB', 'Mobiliar'].includes(provider.name)))('$name rejects foreign URL publication', async (provider) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it.each([['URL-less', undefined], ['relative', '/job/Bern-Engineer/12345/']])('Mobiliar accepts matching %s singleton', async (_kind, recordUrl) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(String(url) === mobiliarUrl
    ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url: recordUrl, datePosted: past })}</script><h1>${title}</h1><h2>Das bringst du mit</h2><p>${body}</p>`
    : `<urlset><url><loc>${mobiliarUrl}</loc></url></urlset>`, { status: 200 })));
  const pending = fetchAllMobiliarJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: past, datePosted: past, postingDateSource: 'reported' });
});
