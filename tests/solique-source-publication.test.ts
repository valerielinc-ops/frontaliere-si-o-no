import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()), fetchHtml,
}));
import { fetchAllAdullamJobs } from '../scripts/lib/adullam-job-parser.mjs';
import { fetchAllIpwJobs } from '../scripts/lib/ipw-job-parser.mjs';
import { fetchAllKantonZuerichJobs } from '../scripts/lib/kanton-zuerich-job-parser.mjs';
import { fetchAllOttosJobs } from '../scripts/lib/ottos-job-parser.mjs';
import { fetchAllSpitalEmmentalJobs } from '../scripts/lib/spital-emmental-job-parser.mjs';
import { fetchAllSpitalMuriJobs } from '../scripts/lib/spital-muri-job-parser.mjs';
import { fetchAllSpitalOberengadinJobs } from '../scripts/lib/spital-oberengadin-job-parser.mjs';
import { fetchAllSvarJobs } from '../scripts/lib/svar-spitalverbund-ar-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const consumers = [
  ['adullam', fetchAllAdullamJobs], ['ipw', fetchAllIpwJobs],
  ['kanton-zuerich', fetchAllKantonZuerichJobs], ['ottos', fetchAllOttosJobs],
  ['spital-emmental', fetchAllSpitalEmmentalJobs], ['spital-muri', fetchAllSpitalMuriJobs],
  ['spital-oberengadin', fetchAllSpitalOberengadinJobs], ['svar-spitalverbund-ar', fetchAllSvarJobs],
] as const;
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const body = 'Sie arbeiten gemeinsam mit unserem erfahrenen Team an anspruchsvollen Aufgaben. '.repeat(12);

describe.each(consumers)('Solique %s source publication through real scheduled wrapper', (_name, fetchJobs) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] }); fetchHtml.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each([['timestamp', past], ['missing', undefined], ['invalid calendar', invalid], ['future', future]])(
    '%s stays atomic through existing-record merge; never uses Eintritt or metadata', async (_kind, datePosted) => {
      fetchHtml.mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/data')) return JSON.stringify({ jobs: [{
          title: { id: '1234', value: 'Fachperson Pflege' }, location: { value: 'Zürich' },
          link: 'job/details/1234', from: { value: '80' }, to: { value: '100' },
          startDate: past, created: past, updated: past,
        }] });
        if (!url.includes('/job/details/')) return `<div class="job"><a href="job/details/1234"><div class="jobtitle">Fachperson Pflege</div><div class="location">Zürich</div><div class="startdate">${past}</div></a></div>`;
        return `<div class="intro">${body}</div><script type="application/ld+json">${JSON.stringify({
          '@graph': [{ '@type': 'JobPosting', datePosted, description: body,
            dateCreated: past, dateModified: past, jobStartDate: past }],
        })}</script>`;
      });
      const pending = fetchJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(fetchHtml).toHaveBeenCalledTimes(2);
      const fresh = jobs[0];
      const expected = datePosted === past ? { datePosted: past, postedDate: past, postingDateSource: 'reported' } : unknown;
      expect(fresh).toMatchObject(expected);
      expect(Number.isFinite(Date.parse(fresh.crawledAt))).toBe(true);
      const previous = { ...fresh, datePosted: past, postedDate: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], [fresh], { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
    },
  );
});
