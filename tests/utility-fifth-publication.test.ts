import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllInterdiscountJobs } from '../scripts/lib/interdiscount-job-parser.mjs';
import { fetchAllJumboJobs } from '../scripts/lib/jumbo-job-parser.mjs';
import { fetchAllKantonAargauJobs } from '../scripts/lib/kanton-aargau-job-parser.mjs';
import { fetchAllKantonGrJobs } from '../scripts/lib/kanton-gr-job-parser.mjs';
const title = 'Fachperson Kundenberatung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const [name, producer] of [['Interdiscount', fetchAllInterdiscountJobs], ['Jumbo', fetchAllJumboJobs]] as const) {
  for (const start of ['valid', 'missing', 'invalid', 'future']) {
    it(`${name} unproven tenant start_date ${start} stays unknown`, async () => {
      const raw = start === 'valid' ? '2025-01-01T00:00:00Z' : start === 'invalid' ? 'not-a-date' : start === 'future' ? '2999-01-01' : undefined;
      const transport = vi.fn(async () => new Response(JSON.stringify({ total: 1, jobs: [{ id: '1', viewkey: '0123456789abcdef', title, start_date: raw, szas: { sza_title: title, 'sza_workplace.city': 'Lugano', 'sza_workplace.region': 'Ticino', 'sza_workplace.country': 'CH', sza_tasks: body }, attributes: { '30': ['Ticino'] }, links: { directlink: 'https://jobs.coopjobs.ch/jobs/fixture' } }] }), { status: 200 }));
      vi.stubGlobal('fetch', transport); const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown', title, crawledAt: expect.any(String) });
      expect(transport).toHaveBeenCalledTimes(1);
    });
  }
}
for (const [name, producer] of [['Aargau', fetchAllKantonAargauJobs], ['Graubuenden', fetchAllKantonGrJobs]] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future', 'creation-only', 'other-title', 'foreign-url', 'foreign-sameas', 'ambiguous-url-less']) {
    it(`${name} same-detail publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = ['valid', 'other-title', 'foreign-url', 'foreign-sameas', 'ambiguous-url-less'].includes(kind) ? `${year}-06-15T12:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const url = name === 'Aargau' ? 'https://jobs.ag.ch/offene-stellen/fixture/abc' : 'https://apply.refline.ch/514915/1234/pub/1/index.html';
      const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Other vacancy' : title, url: kind === 'ambiguous-url-less' ? undefined : kind === 'foreign-url' ? 'https://wrong.example/other' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/other' : undefined, datePosted: raw, dateCreated: `${year}-01-01`, description: body };
      const detail = `<script type="application/ld+json">${JSON.stringify(kind === 'ambiguous-url-less' ? [posting, { ...posting, datePosted: `${year}-01-01` }] : posting)}</script><div id="bDescription">${body}</div>`;
      const listing = `<tr class="even"><td class="position"><a href="${url}">${title}</a></td><td class="department">Amt</td><td class="workplace">Chur</td><td class="deadline">31.12.2999</td></tr>`;
      const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : name === 'Aargau' ? JSON.stringify({ total: 1, jobs: [{ id: '1', title, startDate: `${year}-01-01`, links: { directlink: url }, attributes: { '20': ['Aarau'] } }] }) : listing, { status: 200 }));
      vi.stubGlobal('fetch', transport); const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].url).toBe(url);
      expect(transport.mock.calls.filter(([input]) => String(input) === url)).toHaveLength(1);
    });
  }
}
