import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllConstelliumJobs } from '../scripts/lib/constellium-job-parser.mjs';
import { fetchAllDeloitteJobs } from '../scripts/lib/deloitte-job-parser.mjs';
import { fetchAllDormakabaJobs } from '../scripts/lib/dormakaba-job-parser.mjs';
import { fetchAllEpflJobs, EPFL_KEY } from '../scripts/lib/epfl-job-parser.mjs';
import { withSourceLangRelabelFlags } from '../scripts/lib/source-lang-relabel.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const deloitteUrl = 'https://apply.deloitte.ch/CHCareers/JobDetail/Technical-Engineer/12345';
const meta = (raw: string) => `<meta itemprop="datePosted" content="${raw}"><meta itemprop="validThrough" content="${past}"><meta itemprop="dateModified" content="${past}"><meta itemprop="jobStartDate" content="${past}">`;
function deloitteDetail(raw: string, label = '', url = deloitteUrl) {
  return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, datePosted: raw, validThrough: past, dateModified: past })}</script><div class="field__label">City</div><div class="field__value">Zurich</div><div class="field__label">Date published</div><div class="field__value">${label}</div><article><h3>Job description</h3><div class="field__value">${body}</div></article>`;
}
const dormaRecord = (raw: string) => ({ jobId: '12345-en_US', language: 'en_US', defaultLanguage: 'en_US', title, legalEntity: 'dormakaba Schweiz AG', brandName: 'dormakaba', datePosted: raw, dateModified: past, createdAt: past, jobStartDate: past, link: 'https://jobs.dormakaba.com/job-invite/12345/?locale=en_US', description: `<p>${body}</p>`, addresses: [{ city: 'Wetzikon', country: 'Schweiz', isPrimary: true }] });
const providers = [
  { name: 'Constellium', run: fetchAllConstelliumJobs, requests: 2, response: (url: string, raw: string) => url.includes('/job/Sierre-Engineer/') ? `${meta(raw)}<span class="jobdescription">${body}</span><p class="job-location"></p>` : `<table><tr class="data-row"><td><a href="/job/Sierre-Engineer/12345/" class="jobTitle-link">${title}</a><span class="jobLocation">Sierre, CH</span></td></tr></table>` },
  { name: 'Deloitte', run: fetchAllDeloitteJobs, requests: 2, response: (url: string, raw: string) => url === deloitteUrl ? deloitteDetail(raw) : `<div class="list-controls__text__legend">1 of 1</div><article class="article article--result"><h3><a href="${deloitteUrl}">${title}</a></h3></article>` },
  { name: 'dormakaba', run: fetchAllDormakabaJobs, requests: 1, response: (_url: string, raw: string) => JSON.stringify({ '@odata.count': 1, value: [dormaRecord(raw)] }) },
  { name: 'EPFL', run: withSourceLangRelabelFlags(fetchAllEpflJobs, EPFL_KEY), requests: 3, response: (url: string, raw: string) => url.includes('/search/') ? url.includes('startrow=0') ? `<table><tr><a href="/job/Lausanne-Engineer/12345/" class="jobTitle-link">${title}</a><span class="jobShifttype">Lausanne</span></tr></table>` : '<table></table>' : `${meta(raw)}<div><span class="jobdescription">${body}</span></div>` },
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
it.each(['valid', 'invalid', 'future'])('Deloitte explicit Date published label: %s', async (kind) => {
  const date = new Date(Date.now() + (kind === 'future' ? 7 : -7) * 86400000);
  const label = kind === 'invalid' ? `30-Feb-${date.getUTCFullYear()}` : `${date.getUTCDate()}-${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${date.getUTCFullYear()}`;
  const provider = providers[1];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(String(url) === deloitteUrl ? deloitteDetail('', label) : provider.response(String(url), ''), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  const expected = kind === 'valid' ? date.toISOString().slice(0, 10) : '';
  expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
});
it('Deloitte rejects same-title foreign URL metadata', async () => {
  const provider = providers[1];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(String(url) === deloitteUrl ? deloitteDetail(past, '', deloitteUrl + '-other') : provider.response(String(url), ''), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
it('dormakaba cannot borrow a date from a translated variant of the authored record', async () => {
  const record = dormaRecord('');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ '@odata.count': 2, value: [record, { ...record, jobId: '12345-de_DE', language: 'de_DE', datePosted: past }] }), { status: 200 })));
  const pending = fetchAllDormakabaJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it.each(providers.filter(provider => ['Constellium', 'EPFL'].includes(provider.name)))('$name preserves full Java-style source timestamp', async (provider) => {
  const date = new Date(Date.now() - 7 * 86400000); date.setUTCMilliseconds(0);
  const words = date.toUTCString().replace(',', '').split(' ');
  const raw = `${words[0]} ${words[2]} ${words[1]} ${words[4]} UTC ${words[3]}`;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), raw), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1);
  const expected = date.toISOString().replace('.000Z', 'Z');
  expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: 'reported' });
});
