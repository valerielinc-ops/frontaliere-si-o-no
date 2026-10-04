import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractWorkdayJobIdentity, parseWorkdayPostedDate, workdayPostingDateFields } from '../scripts/lib/ats-clients/workday-client.mjs';
import { createWorkdaySwissParser } from '../scripts/lib/workday-swiss-job-parser-common.mjs';

const sourceDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
const sourceTimestamp = `${sourceDate}T11:30:00+02:00`;
const roleBody = '<p>The successful candidate works with the engineering team to maintain equipment and develop quality processes. Responsibilities include planning, coordination, documentation and reviewing technical requirements with colleagues. Relevant qualifications, professional experience and communication skills are required. The employer offers training, a collaborative working environment and opportunities for professional development. Apply with your CV and supporting documents.</p>';

afterEach(() => vi.unstubAllGlobals());

describe('Workday source publication dates', () => {
  it.each(['', 'Posted Today', 'Posted Yesterday', 'Posted 30+ Days Ago', 'Posted 2 Weeks Ago', 'illegible', '2025-02-30'])('does not turn %s into an exact publication date', raw => {
    expect(parseWorkdayPostedDate(raw)).toBeNull();
  });

  it('preserves explicit source timestamps and their offsets', () => {
    expect(parseWorkdayPostedDate(sourceTimestamp)).toBe(sourceTimestamp);
  });

  it('prefers verified detail startDate over coarse postedOn', () => {
    const identity = extractWorkdayJobIdentity({ postedOn: 'Posted 30+ Days Ago', jobPostingInfo: { startDate: sourceDate } });
    expect(identity).toMatchObject({ postedAt: sourceDate, postedDate: sourceDate, datePosted: sourceDate, postingDateSource: 'reported' });
  });

  it('does not treat an arbitrary top-level employment startDate as publication', () => {
    expect(workdayPostingDateFields({ startDate: sourceDate }).postingDateSource).toBe('unknown');
  });

  it('rejects future detail dates without replacing them with crawl time', () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    expect(workdayPostingDateFields({ jobPostingInfo: { startDate: future, postedOn: 'Posted Today' } })).toEqual({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
  });

  it.each([sourceDate, ''])('carries detail publication provenance through the real factory: %s', startDate => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ total: 1, jobPostings: [{ title: 'Engineer', externalPath: '/job/Zurich/Engineer_R1', locationsText: 'Zurich, Switzerland', postedOn: 'Posted 30+ Days Ago', bulletFields: ['R1'] }] }));
      }
      return new Response(JSON.stringify({ jobPostingInfo: { title: 'Engineer', location: 'Zurich, Switzerland', jobDescription: roleBody, startDate, postedOn: 'Posted 30+ Days Ago', country: { alpha2Code: 'CH' } } }));
    }));
    const parser = createWorkdaySwissParser({ companyKey: 'testco', companyName: 'Test Co', companyDomain: 'testco.com', tenantHost: 'testco.wd3.myworkdayjobs.com', sitePath: 'Test_Careers', defaultCanton: 'ZH' });
    return parser.fetchAllJobs().then((jobs: any[]) => {
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ postedDate: startDate, datePosted: startDate, postingDateSource: startDate ? 'reported' : 'unknown' });
      expect(jobs[0].crawledAt).toBeTruthy();
    });
  });
});
