import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAbbottJobs } from '../scripts/lib/abbott-job-parser.mjs';
import { fetchAllAlconJobs } from '../scripts/lib/alcon-job-parser.mjs';
import { fetchAllArdianJobs } from '../scripts/lib/ardian-job-parser.mjs';
import { fetchAllBernerMontageJobs } from '../scripts/lib/berner-montage-job-parser.mjs';
import { fetchAllBossardJobs } from '../scripts/lib/bossard-job-parser.mjs';

const replay = vi.hoisted(() => ({ listingDate: '', detailDate: '' }));
vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const info = () => ({ startDate: replay.detailDate, location: 'Zurich, Switzerland', timeType: 'Full time',
    jobDescription: 'Swiss engineering role based in Zurich with responsibility for quality, operations and technical support. '.repeat(10) });
  return { ...actual,
    async *fetchWorkdayJobs() {
      yield { title: 'Quality engineer', externalPath: '/job/Zurich/Quality_R1', locationsText: 'Zurich, Switzerland',
        postedOn: replay.listingDate || 'Posted 3 Days Ago', bulletFields: ['R1'] };
    },
    fetchWorkdayJobDetail: async () => ({ jobPostingInfo: info() }),
    fetchWorkdayJobDetailParts: async () => ({ info: info(), text: info().jobDescription }),
  };
});
vi.mock('../scripts/lib/workday-swiss-job-parser-common.mjs', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  fetchWorkdayPrimarySwissLocation: async () => 'Zurich', fetchWorkdaySwissCanton: async () => 'ZH',
}));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  replay.listingDate = ''; replay.detailDate = '';
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
describe.each([
  ['Abbott', fetchAllAbbottJobs], ['Alcon', fetchAllAlconJobs], ['Ardian', fetchAllArdianJobs],
  ['Berner Montage', fetchAllBernerMontageJobs], ['Bossard', fetchAllBossardJobs],
] as const)('%s publication provenance through discovery and detail', (_name, crawl) => {
  it.each(['2026-09-23', '', '2026-02-30', '2026-10-04'])('validates detail publication %j without inventing a date from relative labels', async (raw) => {
    replay.detailDate = raw;
    const jobs = await crawl();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description.length).toBeGreaterThan(100);
    expect(jobs[0]).toMatchObject(raw === '2026-09-23'
      ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : unknown);
  });
  it('preserves an absolute listing publication when the detail omits it', async () => {
    replay.listingDate = '2026-09-22';
    const jobs = await crawl();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '2026-09-22', postedDate: '2026-09-22', postingDateSource: 'reported' });
  });
});
