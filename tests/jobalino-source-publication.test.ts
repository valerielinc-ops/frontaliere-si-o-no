import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKlinikSchoenbergJobs } from '../scripts/lib/klinik-schoenberg-job-parser.mjs';
import { fetchAllMichelGruppeJobs } from '../scripts/lib/michel-gruppe-job-parser.mjs';
import { fetchAllPrivatklinikMeiringenJobs } from '../scripts/lib/privatklinik-meiringen-job-parser.mjs';
import { fetchAllRehaklinikHaslibergJobs } from '../scripts/lib/rehaklinik-hasliberg-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const consumers = [
  ['Schönberg', fetchAllKlinikSchoenbergJobs], ['Michel Gruppe', fetchAllMichelGruppeJobs],
  ['Meiringen', fetchAllPrivatklinikMeiringenJobs], ['Hasliberg', fetchAllRehaklinikHaslibergJobs],
] as const;
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

describe.each(consumers)('Jobalino actual %s producer', (company, fetchJobs) => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([['timestamp', past], ['missing', undefined], ['invalid', invalid], ['future', future]])(
    '%s keeps publication provenance through DCC merge', async (_kind, datePosted) => {
      const transport = vi.fn(async (url: string) => {
        const listing = `<a href="https://my.jobalino.ch/job/abc123/pflege" class="reflink"><span class="title">Fachperson Pflege</span><span class="company">${company}</span><span class="city">Meiringen</span></a>`;
        const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Fachperson Pflege', datePosted,
          dateCreated: past, dateModified: past, jobStartDate: past, description: 'Sie arbeiten gemeinsam mit unserem erfahrenen Team. '.repeat(15),
        })}</script>`;
        return new Response(url.includes('/custel_jobExternalList/') ? `jb_ShowJsonHtml(${JSON.stringify({html: listing})});` : detail);
      });
      vi.stubGlobal('fetch', transport);
      const jobs = await fetchJobs(); expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(2);
      const expected = datePosted === past ? { datePosted: past, postedDate: past, postingDateSource: 'reported' } : unknown;
      expect(jobs[0]).toMatchObject(expected); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], datePosted: past, postedDate: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: {id: string}) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
    },
  );
});
