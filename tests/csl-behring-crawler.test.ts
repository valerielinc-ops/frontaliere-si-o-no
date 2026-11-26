import { afterEach, describe, expect, it, vi } from 'vitest';

const workdayMocks = vi.hoisted(() => ({
  createWorkdayRequestContext: vi.fn(),
  fetchWorkdayJobs: vi.fn(),
  fetchWorkdayJobDetail: vi.fn(),
}));

vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/ats-clients/workday-client.mjs')>(),
  createWorkdayRequestContext: workdayMocks.createWorkdayRequestContext,
  fetchWorkdayJobs: workdayMocks.fetchWorkdayJobs,
  fetchWorkdayJobDetail: workdayMocks.fetchWorkdayJobDetail,
}));

import {
  CSL_BEHRING_KEY,
  CSL_BEHRING_COMPANY_NAME,
  fetchAllCslBehringJobs,
  isCslBehringJob,
  isTrustedDomain,
  resolveCslLocation,
  resolveCslPublishLocation,
} from '../scripts/lib/csl-behring-job-parser.mjs';
import { WorkdayAuthError } from '../scripts/lib/ats-clients/workday-client.mjs';

afterEach(() => {
  workdayMocks.createWorkdayRequestContext.mockReset();
  workdayMocks.fetchWorkdayJobs.mockReset();
  workdayMocks.fetchWorkdayJobDetail.mockReset();
});

describe('CSL Behring crawler parser', () => {
  it('resolves a normal Swiss Workday location', () => {
    expect(resolveCslLocation('EMEA, CH, Kanton Bern, Bern, CSL Behring')).toBe('Bern');
  });

  it('uses a Swiss additional location when the primary posting location is foreign', () => {
    expect(resolveCslLocation(
      'Americas, US-PA, King of Prussia, CSL Behring',
      [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    )).toBe('Glattbrugg');
  });

  // The union above is NOT the publish decision. Measured on
  // data/jobs/by-crawler/csl-behring.json: 12 of 25 records carried a non-Swiss
  // primary location in their own Workday path (US-PA King of Prussia, US-MA
  // Waltham, GB Berkshire-Maidenhead) and were published as Glattbrugg,
  // Opfikon or Bern. All 13 correctly-published records have an `EMEA-CH-*`
  // primary.
  it('refuses to publish a foreign req that merely lists a Swiss site alongside', () => {
    const crossPosted = {
      location: 'Americas, US-PA, King of Prussia, CSL Behring',
      additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    };
    // The union still resolves a Swiss city…
    expect(resolveCslLocation(crossPosted.location, crossPosted.additionalLocations)).toBe('Glattbrugg');
    // …but the publish decision reads only the req's own primary location.
    expect(resolveCslPublishLocation(crossPosted)).toBe('');
  });

  it('publishes a req whose own primary location is Swiss', () => {
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Glattbrugg, CSL Behring',
      additionalLocations: [{ descriptor: 'Americas, US-PA, King of Prussia, CSL Behring' }],
    })).toBe('Glattbrugg');
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Kanton Bern, Bern, CSL Behring',
    })).toBe('Bern');
  });

  it('fails closed when the req has no readable primary location', () => {
    // Used to fall back to the hardcoded `Bern` / `BE`, which is the
    // generic-city fallback audit-parser-quality.mjs names in its ACTION line.
    expect(resolveCslPublishLocation({ additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg' }] })).toBe('');
    expect(resolveCslPublishLocation({ location: '' })).toBe('');
    expect(resolveCslPublishLocation({})).toBe('');
  });

  it('resolves detail locations when the listing is only an N Locations roll-up', () => {
    expect(resolveCslLocation(
      '3 Locations',
      [{ descriptor: 'EMEA, CH, Kanton Bern, Bern, CSL Behring' }],
    )).toBe('Bern');
  });

  it('does not invent a Swiss city for foreign-only detail locations', () => {
    expect(resolveCslLocation('Americas, US-PA, King of Prussia, CSL Behring')).toBe('');
  });

  it('does not publish a Swiss additional location when the primary is foreign', () => {
    expect(resolveCslPublishLocation({
      location: 'Americas, US-PA, King of Prussia, CSL Behring',
      additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    })).toBe('');
  });

  it('publishes a Swiss primary location', () => {
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Kanton Bern, Bern, CSL Behring',
      additionalLocations: [{ descriptor: 'Americas, US-PA, King of Prussia' }],
    })).toBe('Bern');
  });

  it('keeps the company matcher and trusted-domain boundary intact', () => {
    expect(CSL_BEHRING_KEY).toBe('csl-behring');
    expect(CSL_BEHRING_COMPANY_NAME).toBe('CSL Behring');
    expect(isCslBehringJob({ companyKey: 'csl-behring' })).toBe(true);
    expect(isCslBehringJob({ company: 'Unrelated', url: 'https://example.test/job' })).toBe(false);
    expect(isTrustedDomain('https://csl.wd1.myworkdayjobs.com/CSL_External/job/1')).toBe(true);
    expect(isTrustedDomain('https://example.test/job/1')).toBe(false);
  });

  it('shares the tenant transport and preserves an anti-bot fetch outcome', async () => {
    const context = { close: vi.fn().mockResolvedValue(undefined) };
    workdayMocks.createWorkdayRequestContext.mockReturnValue(context);
    workdayMocks.fetchWorkdayJobs.mockImplementation(async function* (_apiBase: string, options: any) {
      expect(options.requestContext).toBe(context);
      throw new WorkdayAuthError('anti-bot block', 403, 'https://csl.wd1.myworkdayjobs.com/jobs');
    });

    const jobs = await fetchAllCslBehringJobs();

    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(0);
    expect(jobs.fetchOutcome).toBe('anti_bot_block');
    expect(workdayMocks.fetchWorkdayJobDetail).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('preserves an anti-bot outcome when a detail request is blocked', async () => {
    const context = { close: vi.fn().mockResolvedValue(undefined) };
    workdayMocks.createWorkdayRequestContext.mockReturnValue(context);
    workdayMocks.fetchWorkdayJobs.mockImplementation(async function* (_apiBase: string, options: any) {
      expect(options.requestContext).toBe(context);
      yield {
        title: 'Swiss role',
        externalPath: '/job/Bern/Swiss_R1',
        locationsText: 'EMEA, CH, Bern, CSL Behring',
      };
    });
    workdayMocks.fetchWorkdayJobDetail.mockRejectedValue(
      new WorkdayAuthError('anti-bot block', 403, 'https://csl.wd1.myworkdayjobs.com/job/Bern/Swiss_R1'),
    );

    const jobs = await fetchAllCslBehringJobs();

    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(0);
    expect(jobs.fetchOutcome).toBe('anti_bot_block');
    expect(workdayMocks.fetchWorkdayJobDetail).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('reuses the tenant transport for listing and detail requests', async () => {
    const context = { close: vi.fn().mockResolvedValue(undefined) };
    workdayMocks.createWorkdayRequestContext.mockReturnValue(context);
    workdayMocks.fetchWorkdayJobs.mockImplementation(async function* (_apiBase: string, options: any) {
      expect(options.requestContext).toBe(context);
      yield {
        title: 'Swiss role',
        externalPath: '/job/Bern/Swiss_R1',
        locationsText: 'EMEA, CH, Bern, CSL Behring',
        bulletFields: ['R1'],
      };
    });
    workdayMocks.fetchWorkdayJobDetail.mockImplementation(async (_apiBase: string, _path: string, options: any) => {
      expect(options.requestContext).toBe(context);
      return {
        jobPostingInfo: {
          location: 'EMEA, CH, Bern, CSL Behring',
          jobDescription: '<p>Responsibilities include coordinating projects, preparing documentation, supporting local teams, improving reliable processes, communicating clearly, exercising sound judgement, managing deadlines, collaborating across functions, maintaining accurate records, learning quickly, helping colleagues, solving practical problems, and delivering consistent results in a respectful workplace with professional development, flexible schedules, meaningful ownership, modern tools, and structured support for applicants.</p>',
          timeType: 'Full time',
        },
      };
    });

    const jobs = await fetchAllCslBehringJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Swiss role', location: 'Bern', canton: 'BE' });
    expect(context.close).toHaveBeenCalledOnce();
  });
});
