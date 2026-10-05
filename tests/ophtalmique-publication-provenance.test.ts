import { afterEach, expect, it, vi } from 'vitest';
import { fetchAllOphtalmiqueJobs } from '../scripts/lib/ophtalmique-job-parser.mjs';
const now = new Date();
const past = new Date(now.getTime() - 7 * 86400000).toISOString();
const future = new Date(now.getTime() + 7 * 86400000).toISOString();
const body = 'La clinique propose une collaboration professionnelle pour accompagner les patients avec notre équipe de soins. '.repeat(7);
afterEach(() => vi.unstubAllGlobals());
it.each([['reported',past,past],['missing',undefined,''],['invalid','bad',''],['future',future,''],['invalidcalendar',`${now.getUTCFullYear()-1}-02-30`,'']] as const)('Ophtalmique %s through actual eRecruit fetch and producer', async (_name, raw, expected) => {
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(url.includes('rss') ? '<item><JobID>42</JobID><link>https://emploi.ophtalmique.ch/?page=advertisement_display&amp;id=42</link></item>' : `<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',datePosted:raw,validThrough:past,dateCreated:past})}</script><div class="title-container"><h2>Infirmier</h2></div><div id="advert">${body}</div></main>`, {status:200});
  });
  vi.stubGlobal('fetch',transport);
  const jobs = await fetchAllOphtalmiqueJobs(); expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({postedDate:expected,datePosted:expected,postingDateSource:expected?'reported':'unknown'});
  expect(jobs[0].description).toContain('collaboration professionnelle'); expect(jobs[0].applyUrl).toContain('id=42'); expect(jobs[0].id).toBeTruthy();expect(jobs[0].slug).toBeTruthy();
  expect(transport).toHaveBeenCalledTimes(2);
});
