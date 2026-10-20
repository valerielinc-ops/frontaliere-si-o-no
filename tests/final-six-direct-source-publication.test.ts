import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllSrgSsrJobs } from '../scripts/lib/srg-ssr-job-parser.mjs';
import { fetchAllSuvaJobs } from '../scripts/lib/suva-job-parser.mjs';
import { fetchAllSwicaJobs } from '../scripts/lib/swica-job-parser.mjs';
import { fetchAllValoraJobs } from '../scripts/lib/valora-job-parser.mjs';
import { fetchAllVictorinoxJobs } from '../scripts/lib/victorinox-job-parser.mjs';
import { fetchAllZermattBergbahnenJobs, ZERMATT_BERGBAHNEN_KEY } from '../scripts/lib/zermatt-bergbahnen-job-parser.mjs';
import { withSourceLangRelabelFlags } from '../scripts/lib/source-lang-relabel.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const title = 'Technical Engineer';
const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const srgUrl = 'https://jobs.srgssr.ch/srf/offene-stellen/technical-engineer/11111111-2222-3333-4444-555555555555';
const suvaUrl = 'https://jobs.suva.ch/job/Luzern-Engineer/12345/';
const swicaUrl = 'https://jobs.swica.ch/offene-stellen/technical-engineer/12345';
const valoraUrl = 'https://career.valora.com/en/job/12345/technical-engineer';
const victorUrl = 'https://victorinox-career.talent-soft.com/job/job-technical-engineer_12345.aspx';
const zermattUrl = 'https://www.matterhornparadise.ch/de/technical-engineer_job_12345';
const ld = (raw: string, url: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, url, description: body, datePosted: raw, dateCreated: past, dateModified: past, jobStartDate: past, jobLocation: { address: { addressLocality: 'Zürich', addressCountry: 'CH' } } })}</script>`;
const providers = [
  { name: 'SRG', run: fetchAllSrgSsrJobs, calls: 2, response: (url: string, raw: string, other = false) => url === srgUrl ? ld(raw, other ? srgUrl + '-other' : srgUrl) : `<a href="${srgUrl}"><h1>${title}</h1></a><small>100%, Zürich</small>` },
  { name: 'Suva', run: fetchAllSuvaJobs, calls: 2, response: (url: string, raw: string) => url === suvaUrl ? `<meta property="og:title" content="${title}"><meta itemprop="datePosted" content="${raw}"><meta itemprop="dateModified" content="${past}"><span itemprop="description">${body}</span>` : `<urlset><url><loc>${suvaUrl}</loc><lastmod>${past}</lastmod></url></urlset>` },
  { name: 'Swica', run: fetchAllSwicaJobs, calls: 3, response: (url: string, raw: string, other = false) => url === swicaUrl ? ld(raw, other ? swicaUrl + '-other' : swicaUrl) : `<a href="${swicaUrl}">${title}</a>` },
  { name: 'Valora', run: fetchAllValoraJobs, calls: 2, response: (url: string, raw: string) => {
    const day = raw.slice(0, 10).split('-').reverse().join('.');
    return url === valoraUrl ? `<meta name="title" content="${title}"><div uk-tooltip="Publication date">${day}</div><div uk-tooltip="Job location">Muttenz</div><div uk-tooltip="Modification date">${past}</div><div class="ct-jobs-detail-text">${body}<div class="uk-width-1-3@m"></div></div>` : `<p>1 entries</p><a href="/en/job/12345/technical-engineer">${title}</a>`;
  } },
  { name: 'Victorinox', run: fetchAllVictorinoxJobs, calls: 3, response: (url: string, raw: string, other = false) => url === victorUrl ? `${ld(raw, other ? victorUrl + '-other' : victorUrl)}<main><div id="contenu-ficheoffre" class="offer-detail"><p>${body}</p></div></main>` : `<li class="ts-offer-list-item offer" onclick="location.href='${victorUrl}';"><a class="ts-offer-list-item__title-link" title="${title} (Ref. : 12345) - Product">${title}</a><ul class="ts-offer-list-item__description"><li>Ref. : 12345</li><li>Zermatt</li></ul></li>` },
  { name: 'Zermatt', run: withSourceLangRelabelFlags(fetchAllZermattBergbahnenJobs, ZERMATT_BERGBAHNEN_KEY), calls: 2, response: (url: string, raw: string, other = false) => url === zermattUrl ? `${ld(raw, other ? zermattUrl + '-other' : zermattUrl)}<section class="wysiwyg-usp-area"><p>${body}</p></section>` : JSON.stringify({ success: true, html: `<div class="card-item__body"><h3><a href="${zermattUrl}">${title}</a></h3></div>` }) },
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
      const wanted = provider.name === 'Valora' && expected ? expected.slice(0, 10) : expected;
      const tuple = { postedDate: wanted, datePosted: wanted, postingDateSource: wanted ? 'reported' : 'unknown' };
      expect(jobs[0]).toMatchObject(tuple); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], postedDate: past, datePosted: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(tuple);
    });
  });
}
it.each(providers.filter(provider => ['SRG', 'Swica', 'Victorinox', 'Zermatt'].includes(provider.name)))('$name rejects same-title foreign URL publication', async (provider) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(provider.response(String(url), past, true), { status: 200 })));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});

it.each(providers.filter(provider => ['SRG', 'Swica'].includes(provider.name)))('$name rejects ambiguous URL-less JobPosting publication', async (provider) => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const response = provider.response(String(url), past);
    const multiple = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, description: body, datePosted: past })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, description: body, datePosted: past })}</script>`;
    return new Response(response.includes('application/ld+json') ? multiple : response, { status: 200 });
  }));
  const pending = provider.run(); await vi.runAllTimersAsync(); const jobs = await pending;
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
});
