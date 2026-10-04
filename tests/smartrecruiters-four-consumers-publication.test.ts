import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ job: {} as Record<string, unknown> }));
vi.mock('../scripts/lib/ats-clients/smartrecruiters-client.mjs', () => ({
  fetchSmartRecruitersJobs: async function* () { yield fixture.job; },
}));
import { fetchAllAudemarsPiguetJobs } from '../scripts/lib/audemars-piguet-job-parser.mjs';
import { fetchAllBallyJobs } from '../scripts/lib/bally-job-parser.mjs';
import { fetchAllCernJobs } from '../scripts/lib/cern-job-parser.mjs';
import { fetchAllEpiGeneveJobs } from '../scripts/lib/epi-geneve-job-parser.mjs';

const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${date}T00:15:00+02:00`;
const future = new Date(Date.now() + 7 * 86400000).toISOString();
afterEach(() => vi.restoreAllMocks());

const providers = [
  ['Audemars Piguet', fetchAllAudemarsPiguetJobs],
  ['Bally', fetchAllBallyJobs],
  ['CERN', fetchAllCernJobs],
  ['EPI Genève', fetchAllEpiGeneveJobs],
] as const;
for (const [name, run] of providers) {
  describe(`${name} discovery and builder preserve the shared publication contract`, () => {
    it.each([
      ['reported', { postedAt: timestamp, postedDate: timestamp, datePosted: timestamp, postingDateSource: 'reported' }, timestamp],
      ['unknown', { postedAt: timestamp, postedDate: '', datePosted: '', postingDateSource: 'unknown' }, ''],
      ['legacy', { postedAt: timestamp, postedDate: timestamp }, ''],
      ['future reported', { postedAt: future, postedDate: future, datePosted: future, postingDateSource: 'reported' }, ''],
    ] as const)('%s remains atomic through both projections', async (_label, publication, expected) => {
      fixture.job = {
        title: 'Technical Engineer', location: 'Lugano', applyUrl: 'https://jobs.smartrecruiters.com/Fixture/123-engineer', jobReqId: '123',
        descriptionHtml: '<p>Join our engineering team to develop reliable products and collaborate with customers. Responsibilities include planning, analysis, reporting, quality assurance, documentation, production support, training and continuous improvement. You bring relevant education, excellent communication skills and experience in an international organization. We offer flexible working hours, professional development, modern equipment and a supportive working environment.</p>',
        rawPosting: { id: '123', location: { city: 'Lugano', country: 'CH', region: 'Ticino', postalCode: '6900' } },
        ...publication,
      };
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const jobs = await run();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
    });
  });
}
