import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllSobiJobs } from '../scripts/lib/sobi-job-parser.mjs';
import { fetchAllSwissquoteJobs } from '../scripts/lib/swissquote-job-parser.mjs';
import { fetchAllSmgSwissMarketplaceGroupJobs } from '../scripts/lib/smg-swiss-marketplace-group-job-parser.mjs';

afterEach(() => vi.unstubAllGlobals());
const body = 'The employer describes responsibilities and required experience for a position within the engineering team. '.repeat(6);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

for (const [name, producer] of [['Sobi', fetchAllSobiJobs], ['Swissquote', fetchAllSwissquoteJobs], ['SMG', fetchAllSmgSwissMarketplaceGroupJobs]] as const) {
  describe(`${name} explicit publication evidence`, () => {
    it('preserves releasedDate through the real shared client and ignores creation when release is absent or invalid', async () => {
      const valid = new Date(Date.now() - 4 * 86400000).toISOString();
      const year = new Date().getUTCFullYear();
      for (const releasedDate of [valid, '', 'invalid', `${year}-02-30T10:00:00Z`, new Date(Date.now() + 86400000).toISOString()]) {
        const posting = {
          id: 'fixture', name: 'Software Engineer', releasedDate, createdOn: valid,
          postingUrl: 'https://jobs.smartrecruiters.com/Fixture/fixture', applyUrl: 'https://jobs.smartrecruiters.com/Fixture/fixture?oga=true',
          location: { city: 'Zürich', country: 'ch', region: 'ZH', postalCode: '8001' },
          jobAd: { sections: { jobDescription: { text: body } } },
        };
        vi.stubGlobal('fetch', vi.fn(async (input) => {
          const isList = new URL(String(input)).searchParams.has('limit');
          return new Response(JSON.stringify(isList ? { totalFound: 1, content: [posting] } : posting), { status: 200 });
        }));
        const jobs = await producer();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject(releasedDate === valid
          ? { datePosted: valid, postedDate: valid, postingDateSource: 'reported' }
          : unknown);
        expect(jobs[0].crawledAt).toBeTruthy();
      }
    });
  });
}
