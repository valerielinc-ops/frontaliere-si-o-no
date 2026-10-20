import { afterEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], info: {} as Record<string, unknown> }));
vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/ats-clients/workday-client.mjs')>(),
  async *fetchWorkdayJobs() { yield* source.rows; },
  fetchWorkdayJobDetailParts: async () => ({ text: String(source.info.jobDescription || ''), info: source.info }),
  fetchWorkdayJobDetail: async () => ({ jobPostingInfo: source.info }),
}));
import { fetchAllStrykerJobs } from '../scripts/lib/stryker-job-parser.mjs';
import { fetchAllRocheJobs } from '../scripts/lib/roche-job-parser.mjs';
import { fetchAllLogitechJobs } from '../scripts/lib/logitech-job-parser.mjs';
import { fetchAllNovartisJobs } from '../scripts/lib/novartis-job-parser.mjs';

const body = 'Responsibilities and requirements from the employer. '.repeat(12);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
afterEach(() => { vi.unstubAllGlobals(); source.rows = []; source.info = {}; });

for (const [company, fetchJobs] of [
  ['Stryker', fetchAllStrykerJobs], ['Roche', fetchAllRocheJobs],
  ['Logitech', fetchAllLogitechJobs], ['Novartis', fetchAllNovartisJobs],
] as const) {
  describe(`${company} publication source through discovery and builder`, () => {
    async function replay(postedOn: string, startDate: string) {
      source.rows = [{ title: 'Engineer', locationsText: 'Basel, Switzerland', externalPath: '/job/Basel/Engineer_REQ123', bulletFields: ['REQ123'], postedOn }];
      source.info = { jobDescription: body, location: 'Basel, Switzerland', country: { descriptor: 'Switzerland' }, timeType: 'Full time', startDate };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jobPostingInfo: source.info }), { headers: { 'content-type': 'application/json' } })));
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      return jobs[0];
    }
    it('replaces an imprecise relative listing label with corroborated Workday detail publication', async () => {
      const date = new Date(Date.now() - 5 * 86400000).toISOString();
      expect(await replay('Posted 30+ Days Ago', date)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    });
    it('carries exact listing evidence through the previously mismatched postedAt/postedDate fields', async () => {
      const date = new Date(Date.now() - 8 * 86400000).toISOString();
      expect(await replay(date, '')).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    });
    it('keeps relative-only, malformed and future dates unknown instead of using collection time', async () => {
      for (const date of ['', 'invalid', new Date(Date.now() + 86400000).toISOString()]) {
        expect(await replay('Posted Today', date)).toMatchObject(unknown);
      }
    });
  });
}
