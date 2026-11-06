import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllFaulhaberJobs } from '../scripts/lib/faulhaber-job-parser.mjs';
import { fetchAllFondationDomusJobs } from '../scripts/lib/fondation-domus-job-parser.mjs';
import { fetchAllGemeindeStMoritzJobs } from '../scripts/lib/gemeinde-st-moritz-job-parser.mjs';
const title = 'Fachperson Kundenberatung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const name of ['Faulhaber', 'Domus', 'Gemeinde'] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future', 'creation-only', 'foreign-url', 'other-title'] as const) {
    it(`${name}: same-detail publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = ['valid', 'foreign-url', 'other-title'].includes(kind) ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const url = name === 'Faulhaber' ? 'https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/stellenangebot/57372/fixture' : name === 'Domus' ? 'https://www.jobup.ch/fr/emplois/detail/fixture/' : 'https://www.gemeinde-stmoritz.ch/aktuelles/offene-stellen/detail/fixture';
      const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Other vacancy' : title, url: kind === 'foreign-url' ? 'https://elsewhere.example/foreign' : url, description: body, datePosted: raw, dateCreated: `${year}-01-01` };
      const ld = `<script type="application/ld+json">${JSON.stringify(posting)}</script>`;
      const detail = name === 'Faulhaber' ? `${ld}<div class="annonce"><h1>${title}</h1><div id="position"><div class="location">CH - Croglio</div><div class="annonce-row">${body}</div></div></div>` : `${ld}<main><article class="news-detail"><h1>${title}</h1><span>7. April ${year}</span><div class="ce-bodytext"><p>${body}</p></div></article></main>`;
      const listing = name === 'Faulhaber' ? JSON.stringify({ JoboffersCount: 1, Joboffers: [{ Id: 57372, JobofferName: title, LocationName: 'CH - Croglio', JobofferUrl: url }] }) : name === 'Domus' ? `<h3>${title}</h3><h5>Date de début</h5>17 mars ${year}<a href="${url}">Postuler</a>` : `<a href="${url}" class="card-link"><div class="card"><h3>${title}</h3><span>7. April ${year}</span><p>${body}</p></div></a>`;
      const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : listing, { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const html = vi.fn(async (requestUrl: string) => requestUrl === url ? detail : listing);
      const pending = name === 'Faulhaber' ? fetchAllFaulhaberJobs({ fetchHtmlImpl: html, fetchJinaImpl: vi.fn() }) : name === 'Domus' ? fetchAllFondationDomusJobs({ fetchPage: async () => listing }) : fetchAllGemeindeStMoritzJobs();
      await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('engagierten Team');
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(jobs[0].url).toBe(url);
      expect(name === 'Faulhaber' ? html : transport).toHaveBeenCalledTimes(name === 'Domus' ? 1 : 2);
    });
  }
}
for (const [label, date, reported] of [['Date de publication', '17 mars', true], ['Date de publication', '31 avril', false], ['Date de début', '17 mars', false], ['Date', '17 mars', false]] as const) {
  it(`Domus label ${label} ${date} is publication=${reported}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const pending = fetchAllFondationDomusJobs({ fetchPage: async () => `<h3>${title}</h3><h5>${label}</h5>${date} ${year}<a href="https://www.fondation-domus.ch/apply">Postuler</a>` });
    await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(reported ? { datePosted: `${year}-03-17`, postedDate: `${year}-03-17`, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
}
