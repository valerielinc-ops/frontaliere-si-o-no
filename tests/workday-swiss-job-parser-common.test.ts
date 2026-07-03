import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWorkdaySwissParser } from '../scripts/lib/workday-swiss-job-parser-common.mjs';

/**
 * Regression test for the `externalPath` primary-location fallback added
 * alongside the Eraneos crawler. Motivating bug: a tenant that (a) rejects
 * the `locationCountry` facet (HTTP 400) AND (b) reports `locationsText` as
 * a multi-site rollup ("2 Locations") on nearly every posting would have
 * every posting dropped by the strict-mode gate — confirmed live on Eraneos
 * (49/51 postings would be lost). Workday's `externalPath` always carries
 * the primary work-location city (`/job/{Location}/...`), so it's used as a
 * last-resort fallback, gated by `inferSwissTargetCanton` + the existing
 * foreign-location guard so it can only recover legitimate CH jobs.
 */
describe('createWorkdaySwissParser — externalPath location fallback', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  function mockTenant() {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body?.appliedFacets?.locationCountry) {
          // Tenant rejects the country facet, like Eraneos.
          return new Response(
            JSON.stringify({ errorCode: 'HTTP_400', errorCaseId: 'x', httpStatus: 400, message: '' }),
            { status: 400 },
          );
        }
        // Unfiltered board — every posting reports a multi-site rollup.
        return new Response(
          JSON.stringify({
            total: 2,
            jobPostings: [
              {
                title: 'Senior Consultant',
                externalPath: '/job/Zurich/Senior-Consultant_JR1',
                locationsText: '2 Locations',
                postedOn: 'Posted Today',
                bulletFields: ['JR1'],
              },
              {
                title: 'Foreign Consultant',
                externalPath: '/job/Frankfurt/Foreign-Consultant_JR2',
                locationsText: '2 Locations',
                postedOn: 'Posted Today',
                bulletFields: ['JR2'],
              },
            ],
          }),
          { status: 200 },
        );
      }
      // Job detail fetch — fail so the caller falls back to the built-in
      // description (keeps the mock minimal, unrelated to this test).
      return new Response('', { status: 404 });
    });
  }

  it('recovers a Swiss job whose locationsText is an unresolved multi-site rollup', async () => {
    mockTenant();

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
    });

    const jobs = await parser.fetchAllJobs();

    const recovered = jobs.find((j: any) => j.title === 'Senior Consultant');
    expect(recovered).toBeDefined();
    expect(recovered.canton).toBe('ZH');
    expect(recovered.location).toBe('Zurich');
  });

  it('does not recover a foreign-located job via the externalPath fallback', async () => {
    mockTenant();

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs.some((j: any) => j.title === 'Foreign Consultant')).toBe(false);
  });
});
