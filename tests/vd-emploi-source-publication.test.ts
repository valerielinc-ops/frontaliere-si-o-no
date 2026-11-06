import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllEhcVdJobs } from '../scripts/lib/ehc-vd-job-parser.mjs';
import { fetchAllHibJobs } from '../scripts/lib/hib-job-parser.mjs';
import { fetchAllHopitalLaTourJobs } from '../scripts/lib/hopital-la-tour-job-parser.mjs';
import { fetchAllHrcJobs } from '../scripts/lib/hrc-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import fixture from './fixtures/vd-emploi-platform/offers.json';
const consumers = [
  ['ehc-vd', fetchAllEhcVdJobs], ['hib', fetchAllHibJobs],
  ['hopital-la-tour', fetchAllHopitalLaTourJobs], ['hrc', fetchAllHrcJobs],
] as const;
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

describe.each(consumers)('VD emploi %s actual wrapper', (_company, fetchJobs) => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([['timestamp', past], ['dateFrom only', undefined], ['invalid', invalid], ['future', future]])(
    '%s only trusts explicit publishedDate and carries provenance through DCC', async (_kind, publishedDate) => {
      // Captured provider shape. URI removed so each real wrapper builds its own host URL.
      // publishedDate cases are contract fixtures, not proof that today's provider emits it.
      const offer = { ...fixture.hib.offers[0], uri: undefined, dateFrom: past, publishedDate,
        createdAt: past, updatedAt: past, jobStartDate: past };
      const transport = vi.fn(async () => new Response(JSON.stringify({ offers: [offer] })));
      vi.stubGlobal('fetch', transport);
      const jobs = await fetchJobs(); expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(1);
      const expected = publishedDate === past ? { datePosted: past, postedDate: past, postingDateSource: 'reported' } : unknown;
      expect(jobs[0]).toMatchObject(expected); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], datePosted: past, postedDate: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: {id: string}) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
    },
  );
});
