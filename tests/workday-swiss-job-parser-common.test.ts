import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWorkdaySwissParser,
  discoverWorkdayCountryFacet,
  WORKDAY_COUNTRY_FACET_PARAMETERS,
  resolveWorkdayPrimarySwissLocation,
  workdayStructuredForeignPrimaryCountry,
  workdayStructuredPrimaryCountryIsSwiss,
  provesWorkdaySwissAbsentFromBoard,
  isCompleteWorkdayBoard,
} from '../scripts/lib/workday-swiss-job-parser-common.mjs';
import { fetchWorkdayJobs, workdayFacetLeafValues } from '../scripts/lib/ats-clients/workday-client.mjs';
import { evaluateAuthoritativeSnapshot } from '../scripts/lib/crawler-template.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

const ROLE_BODY = '<p>Responsibilities and requirements of the role, described at length by the employer, with the team context and the application steps. You bring relevant experience, good English skills and a structured way of working. We offer flexible working hours, further training and a modern workplace in a friendly and international team.</p>';

/**
 * The publish gate reads the req's OWN primary workplace, never the union of
 * `[info.location, ...info.additionalLocations]`, and the HQ
 * `defaultCity`/`defaultCanton` is no longer a fallback on either the facet or
 * the strict path — a req that does not resolve is dropped.
 *
 * Measured 2026-09-19 across the factory's 10 consumer slices (eraneos 58,
 * everest-re 1, galderma 6, georg-fischer 19, medbase 163,
 * siemens-healthineers 3, temenos 0, trafigura 6, vontobel 32, ferring no
 * slice): 0 misattributed records, so the union is a latent defect. The one
 * live change is siemens-healthineers' 3 records, whose opaque path segments
 * (`LPN-BO`, `TOI-L-112`, `CEY-BO`) were published as `Zurich`/`ZH` purely by
 * the HQ default.
 */
describe('resolveWorkdayPrimarySwissLocation — primary-only publish gate', () => {
  it('refuses a foreign primary even when an additional location is Swiss', () => {
    expect(resolveWorkdayPrimarySwissLocation({
      location: { descriptor: 'Frankfurt, Germany' },
      additionalLocations: [{ descriptor: 'Zug, Switzerland' }],
    })).toBe('');
  });

  it('refuses a req with no primary location', () => {
    expect(resolveWorkdayPrimarySwissLocation({
      additionalLocations: [{ descriptor: 'Zug, Switzerland' }],
    })).toBe('');
    expect(resolveWorkdayPrimarySwissLocation({})).toBe('');
  });

  it('accepts the req own Swiss primary location', () => {
    expect(resolveWorkdayPrimarySwissLocation({
      location: { descriptor: 'Lausanne, Switzerland' },
      additionalLocations: [{ descriptor: 'Frankfurt, Germany' }],
    })).toBe('Lausanne');
  });
});

describe('createWorkdaySwissParser — faceted Workday auth fallback', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  const makeParser = (overrides: Record<string, unknown> = {}) => createWorkdaySwissParser({
    companyKey: 'testco',
    companyName: 'Test Co',
    companyDomain: 'testco.com',
    tenantHost: 'testco.wd3.myworkdayjobs.com',
    sitePath: 'Test_Careers',
    defaultCanton: 'ZH',
    defaultCity: 'Zurich',
    ...overrides,
  });

  it('refetches the live board unfiltered when the Swiss facet is blocked', async () => {
    const listingRequests: any[] = [];
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        listingRequests.push(body);
        if (Object.keys(body.appliedFacets || {}).length > 0) {
          return new Response('', { status: 403 });
        }
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Senior Underwriting Assistant',
            externalPath: '/job/Zurich/Senior-Underwriting-Assistant_R7298',
            locationsText: 'Zurich, Switzerland',
            postedOn: 'Posted Today',
            bulletFields: ['R7298'],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: 'Zurich, Switzerland',
          jobRequisitionLocation: { country: { alpha2Code: 'CH', descriptor: 'Switzerland' } },
          jobDescription: ROLE_BODY,
        },
      }), { status: 200 });
    }) as any;

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs.map((job: any) => job.title)).toEqual(['Senior Underwriting Assistant']);
    expect(listingRequests).toHaveLength(2);
    expect(listingRequests[0].appliedFacets).toEqual({
      locationCountry: ['187134fccb084a0ea9b4b95f23890dbe'],
    });
    expect(listingRequests[1].appliedFacets).toEqual({});
  });

  it('refetches the live board when the Swiss facet returns an empty page', async () => {
    const listingRequests: any[] = [];
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        listingRequests.push(body);
        if (Object.keys(body.appliedFacets || {}).length > 0) {
          return new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Senior Underwriting Assistant',
            externalPath: '/job/Zurich/Senior-Underwriting-Assistant_R7298',
            locationsText: 'Zurich, Switzerland',
            postedOn: 'Posted Today',
            bulletFields: ['R7298'],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: 'Zurich, Switzerland',
          jobRequisitionLocation: { country: { alpha2Code: 'CH', descriptor: 'Switzerland' } },
          jobDescription: ROLE_BODY,
        },
      }), { status: 200 });
    }) as any;

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs.map((job: any) => job.title)).toEqual(['Senior Underwriting Assistant']);
    // Faceted query, the board summary the default-on proof reads (it states
    // no country facet, so nothing is proven), then the unfiltered refetch.
    expect(listingRequests.map((body) => body.appliedFacets)).toEqual([
      { locationCountry: ['187134fccb084a0ea9b4b95f23890dbe'] },
      {},
      {},
    ]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refetches the unfiltered board when an accepted Swiss facet reports zero but the source still lists Switzerland', async () => {
    const listingRequests: any[] = [];
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        listingRequests.push(body);
        if (Object.keys(body.appliedFacets || {}).length > 0) {
          return new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Senior Underwriting Assistant',
            externalPath: '/job/Zurich/Senior-Underwriting-Assistant_R7298',
            locationsText: 'Zurich, Switzerland',
            postedOn: 'Posted Today',
            bulletFields: ['R7298'],
          }],
          facets: [{
            facetParameter: 'Country',
            values: [{ id: '187134fccb084a0ea9b4b95f23890dbe', descriptor: 'Switzerland', count: 1 }],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: 'Zurich, Switzerland',
          jobRequisitionLocation: { country: { alpha2Code: 'CH', descriptor: 'Switzerland' } },
          jobDescription: ROLE_BODY,
        },
      }), { status: 200 });
    }) as any;

    const jobs = await makeParser({
      countryFacetParameter: 'Country',
      proveSwissAbsentFromLiveBoard: true,
    }).fetchAllJobs();

    expect(jobs.map((job: any) => job.title)).toEqual(['Senior Underwriting Assistant']);
    expect(listingRequests.map((body) => body.appliedFacets)).toEqual([
      { Country: ['187134fccb084a0ea9b4b95f23890dbe'] },
      {},
      {},
    ]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('preserves anti-bot outcome when the unfiltered retry is partially yielded', async () => {
    vi.useFakeTimers();
    try {
      const listingRequests: any[] = [];
      const partialPage = Array.from({ length: 20 }, (_, index) => ({
        title: `Swiss role ${index + 1}`,
        externalPath: `/job/Zurich/Swiss-role-${index + 1}`,
        locationsText: 'Zurich, Switzerland',
        postedOn: 'Posted Today',
        bulletFields: [`R${index + 1}`],
      }));
      global.fetch = vi.fn(async (url: string, init: any = {}) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
          const body = JSON.parse(init.body);
          listingRequests.push(body);
          if (Object.keys(body.appliedFacets || {}).length > 0) {
            return new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });
          }
          if (listingRequests.length === 2) {
            return new Response(JSON.stringify({ total: 21, jobPostings: partialPage }), { status: 200 });
          }
          return new Response('', { status: 403 });
        }
        throw new Error(`detail fetch should not run after a partial anti-bot block: ${urlStr}`);
      }) as any;

      // This case pins the unfiltered retry's transport outcome; the proof's
      // board-summary read would take the second listing slot of the mock.
      const jobsPromise = makeParser({ proveSwissAbsentFromLiveBoard: false }).fetchAllJobs();
      await vi.runAllTimersAsync();
      const jobs = await jobsPromise;

      expect(jobs).toHaveLength(20);
      expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
      expect(jobs[0]).toMatchObject({ title: 'Swiss role 1', locationRaw: 'Zurich, Switzerland' });
      expect(listingRequests).toHaveLength(3);
      expect(listingRequests[0].appliedFacets).toEqual({
        locationCountry: ['187134fccb084a0ea9b4b95f23890dbe'],
      });
      expect(listingRequests[1].appliedFacets).toEqual({});
      expect(listingRequests[2].appliedFacets).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an explicit anti-bot outcome when both listing requests are blocked', async () => {
    global.fetch = vi.fn(async (url: string) => (
      String(url).endsWith('/jobs')
        ? new Response('', { status: 403 })
        : new Response('', { status: 404 })
    )) as any;

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
  });

  it('preserves the anti-bot outcome when empty proof is enabled', async () => {
    global.fetch = vi.fn(async (url: string) => (
      String(url).endsWith('/jobs')
        ? new Response('', { status: 403 })
        : new Response('', { status: 404 })
    )) as any;

    const jobs = await makeParser({ proveSwissAbsentFromLiveBoard: true }).fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
  });
});

/**
 * Regression tests for the `externalPath` primary-location fallback added
 * alongside the Eraneos and Medbase crawlers. Motivating bug: a tenant that
 * (a) rejects the `locationCountry` facet (HTTP 400) AND (b) reports
 * `locationsText` as a multi-site rollup ("N Locations") on some or all
 * postings would have those postings dropped by the strict-mode gate —
 * confirmed live on both Eraneos (49/51 postings, every posting rolled up)
 * and Medbase (1/136 postings, a group-wide apprenticeship listing, rolled
 * up to "18 Locations"). Workday's `externalPath` always carries the
 * primary work-location city (`/job/{Location}/...`), so it's used as a
 * last-resort fallback, gated by `inferSwissTargetCanton` + the existing
 * foreign-location guard so it can only recover legitimate CH jobs.
 */
describe('createWorkdaySwissParser — externalPath location fallback (Eraneos: fully-rolled-up board)', () => {
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
      // Job detail: a body but no structured location, so the listing's
      // externalPath is what places the req. (A req without a body is not
      // published at all, issue 5253.)
      return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: ROLE_BODY } }), { status: 200 });
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

describe('createWorkdaySwissParser — externalPath location fallback (Medbase: partial rollup, hyphenated location)', () => {
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
          // Tenant rejects the country facet, like Medbase.
          return new Response(
            JSON.stringify({ errorCode: 'HTTP_400', errorCaseId: 'x', httpStatus: 400, message: '' }),
            { status: 400 },
          );
        }
        // Unfiltered board — one posting reports a multi-site rollup.
        return new Response(
          JSON.stringify({
            total: 2,
            jobPostings: [
              {
                title: 'Apotheker:in für Weiterbildung',
                externalPath: '/job/Winterthur-Schtzenstrasse-HQ/Apotheker-in_JR1',
                locationsText: '18 Locations',
                postedOn: 'Posted Today',
                bulletFields: ['JR1'],
              },
              {
                title: 'Foreign Consultant',
                externalPath: '/job/Frankfurt/Foreign-Consultant_JR2',
                locationsText: '18 Locations',
                postedOn: 'Posted Today',
                bulletFields: ['JR2'],
              },
            ],
          }),
          { status: 200 },
        );
      }
      // Job detail: a body but no structured location, so the listing's
      // externalPath is what places the req. (A req without a body is not
      // published at all, issue 5253.)
      return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: ROLE_BODY } }), { status: 200 });
    });
  }

  it('recovers a Swiss job whose locationsText is an unresolved multi-site rollup', async () => {
    mockTenant();

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd502.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Winterthur',
    });

    const jobs = await parser.fetchAllJobs();

    const recovered = jobs.find((j: any) => j.title === 'Apotheker:in für Weiterbildung');
    expect(recovered).toBeDefined();
    expect(recovered.canton).toBe('ZH');
    expect(recovered.location).toBe('Winterthur-Schtzenstrasse-HQ');
  });

  it('does not recover a foreign-located job via the externalPath fallback', async () => {
    mockTenant();

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd502.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Winterthur',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs.some((j: any) => j.title === 'Foreign Consultant')).toBe(false);
  });
});

describe('createWorkdaySwissParser — detail location wins over an N Locations listing roll-up', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('uses the Swiss detail location instead of the configured HQ fallback', async () => {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Medical Scientific Liaison',
            externalPath: '/job/Lausanne/Medical-Scientific-Liaison_JR1',
            locationsText: '2 Locations',
            postedOn: 'Posted Today',
            bulletFields: ['JR1'],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: 'Lausanne',
          additionalLocations: [{ descriptor: 'Zug' }],
          jobDescription: '<p>Detailed role description with enough content for a realistic vacancy, including responsibilities, required qualifications, team context, and practical application information. You bring relevant experience, good English skills and a structured way of working. We offer flexible working hours, further training and a modern workplace in a friendly and international team.</p>',
        },
      }), { status: 200 });
    });

    const parser = createWorkdaySwissParser({
      companyKey: 'galderma',
      companyName: 'Galderma',
      companyDomain: 'galderma.com',
      tenantHost: 'galderma.wd3.myworkdayjobs.com',
      sitePath: 'External',
      defaultCanton: 'ZG',
      defaultCity: 'Zug',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Lausanne', canton: 'VD' });
    expect(jobs[0].description).toContain('Detailed role description');
  });
});

describe('createWorkdaySwissParser — requisition location override', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('uses the structured requisition workplace when configured', async () => {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Head of Medical Experts',
            externalPath: '/job/Zug/Head-of-Medical-Experts_JR1',
            locationsText: 'Zug',
            postedOn: 'Posted Today',
            bulletFields: ['JR1'],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: 'Zug',
          jobRequisitionLocation: { descriptor: 'Lausanne' },
          jobDescription: '<p>Detailed role description with responsibilities, qualifications, team context, reporting lines, working hours and practical application information for all interested candidates. You bring relevant experience, good English skills and a structured way of working. We offer flexible working hours, further training and a modern workplace in a friendly and international team.</p>',
        },
      }), { status: 200 });
    });

    const parser = createWorkdaySwissParser({
      companyKey: 'galderma',
      companyName: 'Galderma',
      companyDomain: 'galderma.com',
      tenantHost: 'galderma.wd3.myworkdayjobs.com',
      sitePath: 'External',
      defaultCanton: 'ZG',
      defaultCity: 'Zug',
      preferJobRequisitionLocation: true,
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Lausanne', canton: 'VD' });
  });

  it('retains the structured detail workplace when the requisition field is absent', async () => {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Swiss Detail Location Role',
            externalPath: '/job/Zug/Swiss-Detail-Location-Role_JR2',
            locationsText: 'Zug',
            postedOn: 'Posted Today',
            bulletFields: ['JR2'],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: { descriptor: 'Basel, Switzerland' },
          jobDescription: '<p>Detailed role description with responsibilities, qualifications, team context, reporting lines, working hours and practical application information for all interested candidates. You bring relevant experience, good English skills and a structured way of working. We offer flexible working hours, further training and a modern workplace in a friendly and international team.</p>',
        },
      }), { status: 200 });
    });

    const parser = createWorkdaySwissParser({
      companyKey: 'galderma',
      companyName: 'Galderma',
      companyDomain: 'galderma.com',
      tenantHost: 'galderma.wd3.myworkdayjobs.com',
      sitePath: 'External',
      defaultCanton: 'ZG',
      defaultCity: 'Zug',
      preferJobRequisitionLocation: true,
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Basel', canton: 'BS' });
  });
});

describe('createWorkdaySwissParser — detail URL is required for vacancy identity', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('drops a listing without externalPath instead of falling back to the career page', async () => {
    const detailCalls: string[] = [];
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [
            {
              title: 'Part-time Swiss role',
              externalPath: '/job/Zurich/Part-time-Swiss-role_JR1',
              locationsText: 'Zurich',
              timeType: 'Part Time',
              postedOn: 'Posted Today',
              bulletFields: ['JR1'],
            },
            {
              title: 'Listing without detail URL',
              locationsText: 'Zurich',
              postedOn: 'Posted Today',
              bulletFields: ['JR2'],
            },
            {
              title: 'Foreign listing without detail URL',
              locationsText: 'Frankfurt, Germany',
              postedOn: 'Posted Today',
              bulletFields: ['JR3'],
            },
          ],
        }), { status: 200 });
      }
      detailCalls.push(urlStr);
      // A real vacancy body: a req without one is not published (issue 5253).
      return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: ROLE_BODY } }), { status: 200 });
    });

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      careerUrl: 'https://testco.com/careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Part-time Swiss role',
      contract: 'part-time',
      employmentType: 'PART_TIME',
    });
    expect(jobs[0].url).toContain('/job/Zurich/Part-time-Swiss-role_JR1');
    expect(jobs[0].url).not.toBe('https://testco.com/careers');
    expect((jobs as any).missingDetailUrlCount).toBe(1);
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]).not.toContain('undefined');
  });
});

describe('createWorkdaySwissParser — HQ default is not a fallback on the facet path', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  /**
   * The siemens-healthineers shape: the Swiss country facet IS accepted (so
   * `strictSwiss` is false, the path all 11 wrappers take), but the posting's
   * location is an opaque requisition-site code that resolves to no Swiss
   * canton. It used to be published as `defaultCity`/`defaultCanton` —
   * `Zurich`/`ZH` — with `addressCountry: 'CH'`, which is the HQ default
   * firing unverifiably on all 3 of that slice's records. It must now drop.
   */
  it('drops a posting whose location resolves to no Swiss canton instead of stamping the HQ', async () => {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [
            {
              title: 'Opaque site role',
              externalPath: '/job/LPN-BO/Opaque-site-role_JR1',
              locationsText: 'LPN-BO',
              postedOn: 'Posted Today',
              bulletFields: ['JR1'],
            },
            {
              title: 'Real Swiss role',
              externalPath: '/job/Zug/Real-Swiss-role_JR2',
              locationsText: 'Zug',
              postedOn: 'Posted Today',
              bulletFields: ['JR2'],
            },
          ],
        }), { status: 200 });
      }
      // A body without a structured location: the listing's own locality
      // decides, and a req without a body is not published (issue 5253).
      return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: ROLE_BODY } }), { status: 200 });
    });

    const parser = createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zurich',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs.some((j: any) => j.title === 'Opaque site role')).toBe(false);
    expect(jobs.map((j: any) => j.title)).toEqual(['Real Swiss role']);
    expect(jobs[0]).toMatchObject({ location: 'Zug', canton: 'ZG' });
  });
});

/**
 * Issue #9651 (siemens-healthineers). The Swiss facet returns only reqs that
 * are cross-posted to a Swiss site while their PRIMARY workplace is abroad
 * (live 2026-09-24: 3 listings, `N Locations` roll-ups, opaque primary codes,
 * `jobRequisitionLocation.country` GB / DE / FR). The primary-only gate drops
 * all of them by design, and the pipeline read the resulting bare `[]` as
 * "aborted before looking" — keeping the 3 HQ-stamped records live forever.
 *
 * With `proveForeignOnlyBoardEmpty` the parser stamps that zero as
 * source-proven. Every other empty stays a bare `[]`, which the runner's
 * validator refuses (fail-closed, previous slice kept).
 */
describe('createWorkdaySwissParser — foreign-only Swiss board is a proven empty (#9651)', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  const CROSS_POSTS = [
    { site: 'AAA-BO', req: 'R-1', alpha2: 'GB', country: 'United Kingdom' },
    { site: 'BBB-L-1', req: 'R-2', alpha2: 'DE', country: 'Germany' },
    { site: 'CCC-BO', req: 'R-3', alpha2: 'FR', country: 'France' },
  ];

  function posting(p: { site: string; req: string }) {
    return {
      title: `Cross-posted role ${p.req}`,
      externalPath: `/job/${p.site}/Cross-posted-role_${p.req}-1`,
      locationsText: '6 Locations',
      postedOn: 'Posted 3 Days Ago',
      bulletFields: [p.req],
    };
  }

  function detail(p: { site: string; alpha2?: string; country?: string }) {
    const country = p.alpha2
      ? { descriptor: p.country, id: 'x', alpha2Code: p.alpha2 }
      : undefined;
    return {
      jobPostingInfo: {
        title: 'Cross-posted role',
        location: p.site.replace(/-/g, ' '),
        additionalLocations: ['ZZZ T', 'MIL VIP'],
        jobRequisitionLocation: { descriptor: p.site.replace(/-/g, ' '), ...(country ? { country } : {}) },
        ...(p.country ? { country: { descriptor: p.country, id: 'x' } } : {}),
        jobDescription: '<p>Role description</p>',
      },
    };
  }

  function mockBoard(
    postings: any[],
    details: Record<string, any>,
    { listStatus = 200, total = postings.length }: { listStatus?: number; total?: unknown } = {},
  ) {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        if (listStatus !== 200) return new Response('blocked', { status: listStatus });
        return new Response(JSON.stringify({ total, jobPostings: postings }), { status: 200 });
      }
      const hit = Object.keys(details).find((path) => urlStr.endsWith(path));
      if (hit && details[hit]) return new Response(JSON.stringify(details[hit]), { status: 200 });
      return new Response('', { status: 404 });
    });
  }

  function parser(opts: Record<string, unknown> = {}) {
    return createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zurich',
      proveForeignOnlyBoardEmpty: true,
      ...opts,
    });
  }

  function verdict(jobs: any) {
    return evaluateAuthoritativeSnapshot(jobs, {
      validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator('Test Co'),
      allowAuthoritativeEmptySnapshot: true,
      authoritativeSnapshotScope: 'empty-only',
      companyLabel: 'Test Co',
    });
  }

  const allDetails = () => Object.fromEntries(
    CROSS_POSTS.map((p) => [posting(p).externalPath, detail(p)]),
  );

  it('stamps a whole board of foreign-primary cross-posts as a proven zero', async () => {
    mockBoard(CROSS_POSTS.map(posting), allDetails());
    const jobs = await parser().fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect((jobs as any).authoritativeEmptyEvidence).toMatch(/R-1:GB, R-2:DE, R-3:FR/);
    expect(verdict(jobs)).toEqual({ authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true });
  });

  it('leaves other factory consumers unchanged: no opt-in, no stamp', async () => {
    mockBoard(CROSS_POSTS.map(posting), allDetails());
    const jobs = await parser({ proveForeignOnlyBoardEmpty: false }).fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refuses the proof when one detail failed to load', async () => {
    const details = allDetails();
    details[posting(CROSS_POSTS[1]).externalPath] = null;
    mockBoard(CROSS_POSTS.map(posting), details);
    const jobs = await parser().fetchAllJobs();
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(() => verdict(jobs)).toThrow(/not a proven authoritative empty state/);
  });

  it('refuses the proof when one req states no structured country', async () => {
    const details = allDetails();
    details[posting(CROSS_POSTS[2]).externalPath] = detail({ site: CROSS_POSTS[2].site });
    mockBoard(CROSS_POSTS.map(posting), details);
    const jobs = await parser().fetchAllJobs();
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refuses the proof on a zero-listing board (a facet the tenant stopped honouring looks the same)', async () => {
    mockBoard([], {});
    const jobs = await parser().fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refuses the proof on an anti-bot block', async () => {
    mockBoard(CROSS_POSTS.map(posting), allDetails(), { listStatus: 403 });
    const jobs = await parser().fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(() => verdict(jobs)).toThrow(/not a proven authoritative empty state/);
  });

  it('refuses the proof when a later page fails and the board is partial', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      site: `S${i}-BO`, req: `R-${100 + i}`, alpha2: 'GB', country: 'United Kingdom',
    }));
    // Page 0 is full; page 1 fails, which `fetchWorkdayJobs` swallows.
    let calls = 0;
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        calls += 1;
        if (calls > 1) return new Response('', { status: 404 });
        return new Response(JSON.stringify({ total: 25, jobPostings: many.map(posting) }), { status: 200 });
      }
      const p = many.find((m) => urlStr.endsWith(posting(m).externalPath));
      return p ? new Response(JSON.stringify(detail(p)), { status: 200 }) : new Response('', { status: 404 });
    });
    const jobs = await parser().fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  }, 30_000);

  it('refuses the proof on a short page whose total announces more postings', async () => {
    // Page 0 says 5 but ships 3 and is short, so pagination stops at 3.
    mockBoard(CROSS_POSTS.map(posting), allDetails(), { total: 5 });
    const jobs = await parser().fetchAllJobs();
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(() => verdict(jobs)).toThrow(/not a proven authoritative empty state/);
  });

  it('refuses the proof when page 0 carries no usable total', async () => {
    for (const total of [0, null, '3']) {
      mockBoard(CROSS_POSTS.map(posting), allDetails(), { total });
      const jobs = await parser().fetchAllJobs();
      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    }
  });

  it('refuses the proof when a req country code is not ISO 3166-1', async () => {
    for (const code of ['UK', 'ZZ', 'XX', 'EU', 'G1']) {
      const details = allDetails();
      details[posting(CROSS_POSTS[0]).externalPath] = detail({ ...CROSS_POSTS[0], alpha2: code });
      mockBoard(CROSS_POSTS.map(posting), details);
      const jobs = await parser().fetchAllJobs();
      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    }
  });

  it('never stamps a board that yields a Swiss-primary job', async () => {
    const swiss = { site: 'Zug', req: 'R-9' };
    mockBoard([...CROSS_POSTS.map(posting), posting(swiss)], {
      ...allDetails(),
      [posting(swiss).externalPath]: {
        jobPostingInfo: {
          location: 'Zug',
          jobRequisitionLocation: { descriptor: 'Zug', country: { descriptor: 'Switzerland', alpha2Code: 'CH' } },
          jobDescription: ROLE_BODY,
        },
      },
    });
    const jobs = await parser().fetchAllJobs();
    expect(jobs.map((j: any) => j.location)).toEqual(['Zug']);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });
});

describe('workdayStructuredForeignPrimaryCountry', () => {
  it('reads the requisition alpha-2 first and ignores Switzerland', () => {
    expect(workdayStructuredForeignPrimaryCountry({
      jobRequisitionLocation: { country: { alpha2Code: 'gb', descriptor: 'United Kingdom' } },
    })).toBe('GB');
    expect(workdayStructuredForeignPrimaryCountry({
      jobRequisitionLocation: { country: { alpha2Code: 'CH', descriptor: 'Switzerland' } },
      country: { descriptor: 'Germany' },
    })).toBe('');
  });

  it('falls back to an explicitly foreign country descriptor', () => {
    expect(workdayStructuredForeignPrimaryCountry({ country: { descriptor: 'Germany' } })).toBe('Germany');
    expect(workdayStructuredForeignPrimaryCountry({ country: { descriptor: 'Switzerland' } })).toBe('');
  });

  it('refuses a code that is not an assigned ISO 3166-1 alpha-2, and does not fall back to the descriptor', () => {
    for (const code of ['UK', 'ZZ', 'XX', 'EU', 'QO', 'G1', 'GBR']) {
      expect(workdayStructuredForeignPrimaryCountry({
        jobRequisitionLocation: { country: { alpha2Code: code, descriptor: 'Germany' } },
        country: { descriptor: 'Germany' },
      })).toBe('');
    }
  });

  it('never manufactures a verdict from missing or opaque data', () => {
    expect(workdayStructuredForeignPrimaryCountry({})).toBe('');
    expect(workdayStructuredForeignPrimaryCountry({ location: 'CEY BO' })).toBe('');
    expect(workdayStructuredForeignPrimaryCountry(undefined as any)).toBe('');
  });
});

describe('isCompleteWorkdayBoard — completeness evidence for the proven zero', () => {
  it('accepts only yielded === collected === a positive first-page total, ended on its own terms', () => {
    expect(isCompleteWorkdayBoard({ firstPageTotal: 3, yielded: 3, endReason: 'total-reached' }, 3)).toBe(true);
    expect(isCompleteWorkdayBoard({ firstPageTotal: 3, yielded: 3, endReason: 'short-page' }, 3)).toBe(true);
  });

  it('fails closed on every other shape', () => {
    expect(isCompleteWorkdayBoard({ firstPageTotal: 5, yielded: 3, endReason: 'short-page' }, 3)).toBe(false);
    expect(isCompleteWorkdayBoard({ firstPageTotal: 3, yielded: 3, endReason: 'page-error' }, 3)).toBe(false);
    expect(isCompleteWorkdayBoard({ firstPageTotal: 3, yielded: 3, endReason: 'max-pages' }, 3)).toBe(false);
    expect(isCompleteWorkdayBoard({ firstPageTotal: 3, yielded: 3, endReason: 'total-reached' }, 2)).toBe(false);
    expect(isCompleteWorkdayBoard({ firstPageTotal: 0, yielded: 0, endReason: 'empty-page' }, 0)).toBe(false);
    expect(isCompleteWorkdayBoard({ firstPageTotal: null, yielded: 3, endReason: 'short-page' }, 3)).toBe(false);
    expect(isCompleteWorkdayBoard({}, 0)).toBe(false);
    expect(isCompleteWorkdayBoard(undefined as any, 0)).toBe(false);
  });
});

describe('fetchWorkdayJobs — optional stats report how pagination ended', () => {
  const ORIGINAL_FETCH = global.fetch;
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  const row = (i: number) => ({ title: `Role ${i}`, externalPath: `/job/Zug/Role_${i}`, locationsText: 'Zug' });

  it('reports a swallowed later-page failure as page-error', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ total: 3, jobPostings: [row(1), row(2)] }), { status: 200 });
      return new Response('', { status: 404 });
    });
    const stats: any = {};
    const seen = [];
    for await (const p of fetchWorkdayJobs('https://t.wd3.myworkdayjobs.com/wday/cxs/t/S', { pageSize: 2, minDelayMs: 0, stats })) seen.push(p);
    expect(seen).toHaveLength(2);
    expect(stats).toEqual({ firstPageTotal: 3, yielded: 2, endReason: 'page-error' });
  });

  it('reports a whole board as total-reached, and yields the same postings with or without stats', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ total: 2, jobPostings: [row(1), row(2)] }), { status: 200 }));
    const stats: any = {};
    const withStats = [];
    for await (const p of fetchWorkdayJobs('https://t.wd3.myworkdayjobs.com/wday/cxs/t/S', { minDelayMs: 0, stats })) withStats.push(p);
    const without = [];
    for await (const p of fetchWorkdayJobs('https://t.wd3.myworkdayjobs.com/wday/cxs/t/S', { minDelayMs: 0 })) without.push(p);
    expect(withStats).toEqual(without);
    expect(stats).toEqual({ firstPageTotal: 2, yielded: 2, endReason: 'total-reached' });
  });
});

/**
 * issue 5253 / crawler-health-monitor, misurato dal vivo il 2026-09-24:
 * georg-fischer pubblicava il cantone `Graubunden` per la sede primaria
 * `Seewis, Graubunden` (il BFS scrive «Seewis im Prättigau»).
 */
describe('createWorkdaySwissParser — canton-only segments', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  function mockFacetTenant(postings: any[], details: Record<string, any>) {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ total: postings.length, jobPostings: postings }), { status: 200 });
      }
      const key = Object.keys(details).find((path) => urlStr.endsWith(path));
      if (!key || details[key] === null) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ jobPostingInfo: details[key] }), { status: 200 });
    });
  }

  const makeParser = () => createWorkdaySwissParser({
    companyKey: 'testco',
    companyName: 'Test Co',
    companyDomain: 'testco.com',
    tenantHost: 'testco.wd3.myworkdayjobs.com',
    sitePath: 'Test_Careers',
    careerUrl: 'https://testco.com/careers',
    defaultCanton: 'ZH',
    defaultCity: 'Zürich',
  });

  it('keeps the locality before a canton segment instead of publishing the canton', async () => {
    // `Conters` è «Conters im Prättigau» nel BFS e non ha alias: prima usciva
    // il solo `Graubunden`, come per la sede GF di Seewis.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFacetTenant(
      [{ title: 'Quality Engineer Production', externalPath: '/job/Conters-Graubunden/Quality-Engineer_JR10665', locationsText: 'Conters, Graubunden', bulletFields: ['JR10665'] }],
      { '/job/Conters-Graubunden/Quality-Engineer_JR10665': { title: 'Quality Engineer Production', location: 'Conters, Graubunden', country: { descriptor: 'Switzerland' }, jobDescription: ROLE_BODY } },
    );
    const jobs = await makeParser().fetchAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('Conters, Graubunden');
    expect(jobs[0].canton).toBe('GR');
  });

  it('publishes the short commune name once the gazetteer knows it (Seewis)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFacetTenant(
      [{ title: 'Quality Engineer Production', externalPath: '/job/Seewis-Graubunden/Quality-Engineer_JR10665', locationsText: 'Seewis, Graubunden', bulletFields: ['JR10665'] }],
      { '/job/Seewis-Graubunden/Quality-Engineer_JR10665': { title: 'Quality Engineer Production', location: 'Seewis, Graubunden', country: { descriptor: 'Switzerland' }, jobDescription: ROLE_BODY } },
    );
    const jobs = await makeParser().fetchAllJobs();
    expect(jobs.map((job: any) => [job.location, job.canton])).toEqual([['Seewis', 'GR']]);
  });
});

// Only the posting's own text is published (issue 5253). A req whose detail
// has no body used to go out as a synthetic "Key details" stub (location,
// employer, "apply on the Workday portal"); it is not published any more.
describe('createWorkdaySwissParser — req without a vacancy body', () => {
  const ORIGINAL_FETCH = global.fetch;

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('publishes the req with a body and skips the one without, never inventing text', async () => {
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [
            { title: 'Controller 80-100%', externalPath: '/job/Zug/Controller_R1', locationsText: 'Zug', postedOn: 'Posted Today', bulletFields: ['R1'] },
            { title: 'Buchhalter 80-100%', externalPath: '/job/Zug/Buchhalter_R2', locationsText: 'Zug', postedOn: 'Posted Today', bulletFields: ['R2'] },
          ],
        }), { status: 200 });
      }
      if (urlStr.endsWith('_R1')) return new Response(JSON.stringify({ jobPostingInfo: { location: 'Zug', jobDescription: ROLE_BODY } }), { status: 200 });
      if (urlStr.endsWith('_R2')) return new Response(JSON.stringify({ jobPostingInfo: { location: 'Zug', jobDescription: '<p>Jetzt bewerben</p>' } }), { status: 200 });
      return new Response('', { status: 404 });
    });

    const jobs = await createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      defaultCanton: 'ZG',
      defaultCity: 'Zug',
    }).fetchAllJobs();

    expect(jobs.map((job: any) => job.title)).toEqual(['Controller 80-100%']);
    expect(jobs[0].description).toMatch(/^Responsibilities and requirements of the role/);
    for (const job of jobs) expect(job.description).not.toContain('Key details');
  });
});

/**
 * A workplace named after a LOCALITY rather than a BFS commune (Bodio, merged
 * into Giornico in 2025; Bironico, part of Monteceneri; Brüttisellen, in
 * Wangen-Brüttisellen) is placed by the official locality directory, but only
 * on the req's own structured Swiss country — text alone never licenses it.
 */
describe('resolveWorkdayPrimarySwissLocation — locality directory, gated on the structured country', () => {
  const ch = { descriptor: 'Switzerland', id: '187134fccb084a0ea9b4b95f23890dbe', alpha2Code: 'CH' };

  it('places a Swiss locality that is not a BFS commune when the requisition says CH', () => {
    for (const place of ['Bodio', 'Bironico', 'Brüttisellen']) {
      expect(resolveWorkdayPrimarySwissLocation({
        location: `${place}, Switzerland`,
        jobRequisitionLocation: { descriptor: place, country: ch },
      })).toBe(place);
    }
  });

  it('does not place it from text alone, or against a foreign requisition', () => {
    expect(resolveWorkdayPrimarySwissLocation({ location: 'Bodio' })).toBe('');
    expect(resolveWorkdayPrimarySwissLocation({
      location: 'Bodio',
      jobRequisitionLocation: { descriptor: 'Bodio', country: { descriptor: 'Italy', alpha2Code: 'IT' } },
      country: { descriptor: 'Switzerland', id: '187134fccb084a0ea9b4b95f23890dbe' },
    })).toBe('');
  });

  it('reads the structured country: requisition alpha-2 first, then the posting country id or name', () => {
    expect(workdayStructuredPrimaryCountryIsSwiss({ jobRequisitionLocation: { country: { alpha2Code: 'ch' } } })).toBe(true);
    expect(workdayStructuredPrimaryCountryIsSwiss({ country: { id: '187134fccb084a0ea9b4b95f23890dbe' } })).toBe(true);
    expect(workdayStructuredPrimaryCountryIsSwiss({ country: { descriptor: 'Schweiz' } })).toBe(true);
    expect(workdayStructuredPrimaryCountryIsSwiss({ country: { descriptor: 'Zürich, Switzerland' } })).toBe(false);
    expect(workdayStructuredPrimaryCountryIsSwiss({})).toBe(false);
  });
});

/**
 * Board vuota vs board inesistente. A renamed site answers 404 and never gets
 * here; a site emptied by a migration answers `total: 0`, the same zero as the
 * Swiss facet. Only a live board whose country facet omits Switzerland proves
 * the Swiss zero.
 */
describe('provesWorkdaySwissAbsentFromBoard', () => {
  const facet = (values: Array<{ id: string; descriptor: string; count?: number }>) => [
    { facetParameter: 'Country', values },
  ];
  const FR = { id: 'fr', descriptor: 'France', count: 25 };
  const CH = { id: '187134fccb084a0ea9b4b95f23890dbe', descriptor: 'Switzerland', count: 3 };
  const GENEVA = { id: 'geneva', descriptor: 'ExCo Geneva', count: 1 };

  it('accepts a live board whose country facet omits Switzerland', () => {
    expect(provesWorkdaySwissAbsentFromBoard({ total: 35, postingCount: 20, facets: facet([FR]) }, { facetParameter: 'Country' })).toBe(true);
  });

  it('refuses every other shape', () => {
    const ok = { total: 35, postingCount: 20, facets: facet([FR]) };
    expect(provesWorkdaySwissAbsentFromBoard(null, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, total: 0 }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, total: null }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, facets: [] }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, facets: facet([]) }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard(ok, { facetParameter: 'locationCountry' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, facets: facet([FR, CH]) }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, facets: facet([FR, { id: 'other', descriptor: 'Switzerland' }]) }, { facetParameter: 'Country' })).toBe(false);
    expect(provesWorkdaySwissAbsentFromBoard({ ...ok, facets: facet([FR, GENEVA]) }, { facetParameter: 'Country' })).toBe(false);
  });

  it('flattens nested facet groups to their leaves', () => {
    expect(workdayFacetLeafValues([
      { facetParameter: 'locationMainGroup', values: [{ descriptor: 'Locations', values: [{ id: 'a', descriptor: 'Bodio, Switzerland', count: 1 }] }] },
    ], 'locationMainGroup')).toEqual([{ id: 'a', descriptor: 'Bodio, Switzerland', count: 1 }]);
    expect(workdayFacetLeafValues([], 'Country')).toBeNull();
  });
});

describe('createWorkdaySwissParser — countryFacetParameter', () => {
  const ORIGINAL_FETCH = global.fetch;
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('sends the Swiss ids under the configured facet key, and only proves a zero when opted in', async () => {
    const bodies: any[] = [];
    global.fetch = vi.fn(async (_url: string, init: any = {}) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const filtered = Object.keys(body.appliedFacets).length > 0;
      return new Response(JSON.stringify(filtered
        ? { total: 0, jobPostings: [] }
        : { total: 12, jobPostings: [], facets: [{ facetParameter: 'Country', values: [{ id: 'fr', descriptor: 'France', count: 12 }] }] }), { status: 200 });
    }) as any;
    const make = (proveSwissAbsentFromLiveBoard: boolean) => createWorkdaySwissParser({
      companyKey: 'testco',
      companyName: 'Test Co',
      companyDomain: 'testco.com',
      tenantHost: 'testco.wd3.myworkdayjobs.com',
      sitePath: 'Test_Careers',
      careerUrl: 'https://testco.com/careers',
      defaultCanton: 'ZH',
      defaultCity: 'Zurich',
      countryFacetParameter: 'Country',
      proveSwissAbsentFromLiveBoard,
    });

    const unproven = await make(false).fetchAllJobs();
    expect(bodies[0].appliedFacets).toEqual({ Country: ['187134fccb084a0ea9b4b95f23890dbe'] });
    expect(bodies[1].appliedFacets).toEqual({});
    expect(bodies).toHaveLength(2);
    expect(isAuthoritativeEmptySnapshot(unproven)).toBe(false);

    const proven = await make(true).fetchAllJobs();
    expect(isAuthoritativeEmptySnapshot(proven)).toBe(true);
    expect(bodies.at(-1).appliedFacets).toEqual({});
  });
});

/**
 * The generator of «one PR per Workday tenant» was the facet NAME: a tenant
 * that calls its country facet `Country` / `Location_Country` answers HTTP 400
 * to the default `locationCountry`, the run fell back to the whole board, and
 * the zero could never be proven (the proof needs an ACCEPTED faceted query).
 * Ferring, KONE, Imerys and Temenos each got a hand-written key. The factory
 * now reads the board's facets after that 400 and picks the key itself.
 */
describe('createWorkdaySwissParser — country facet discovery after HTTP 400', () => {
  const ORIGINAL_FETCH = global.fetch;
  const CH_ID = '187134fccb084a0ea9b4b95f23890dbe';
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  const SWISS_POSTING = {
    title: 'Process Engineer',
    externalPath: '/job/Zurich/Process-Engineer_R1',
    locationsText: 'Zurich, Switzerland',
    postedOn: 'Posted Today',
    bulletFields: ['R1'],
  };
  const FOREIGN_POSTING = {
    title: 'Plant Manager',
    externalPath: '/job/Lyon/Plant-Manager_R2',
    locationsText: 'Lyon, France',
    postedOn: 'Posted Today',
    bulletFields: ['R2'],
  };
  const FR = { id: 'fr-id', descriptor: 'France', count: 7 };
  const CH = { id: CH_ID, descriptor: 'Switzerland', count: 1 };

  /**
   * A fake tenant. `accepts` maps each facet key the tenant knows to what the
   * Swiss-faceted query returns; any other key answers HTTP 400. `appliedFacets:
   * {}` (the board summary and the unfiltered refetch alike) returns the whole
   * board with `facets`.
   */
  function mockTenant({
    accepts,
    board,
    boardTotal = board.length,
    facets,
    listStatus = 200,
  }: {
    accepts: Record<string, any[]>;
    board: any[];
    boardTotal?: number;
    facets: any[];
    listStatus?: number;
  }) {
    const bodies: any[] = [];
    global.fetch = vi.fn(async (url: string, init: any = {}) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (listStatus !== 200) return new Response('blocked', { status: listStatus });
        const keys = Object.keys(body.appliedFacets || {});
        if (keys.length === 0) {
          return new Response(JSON.stringify({ total: boardTotal, jobPostings: board, facets }), { status: 200 });
        }
        const postings = accepts[keys[0]];
        if (!postings) {
          return new Response(JSON.stringify({ errorCode: 'HTTP_400', httpStatus: 400 }), { status: 400 });
        }
        return new Response(JSON.stringify({ total: postings.length, jobPostings: postings }), { status: 200 });
      }
      const swiss = urlStr.includes('/job/Zurich/');
      return new Response(JSON.stringify({
        jobPostingInfo: {
          location: swiss ? 'Zurich, Switzerland' : 'Lyon, France',
          jobRequisitionLocation: { country: swiss
            ? { alpha2Code: 'CH', descriptor: 'Switzerland' }
            : { alpha2Code: 'FR', descriptor: 'France' } },
          jobDescription: ROLE_BODY,
        },
      }), { status: 200 });
    }) as any;
    return bodies;
  }

  const makeParser = (overrides: Record<string, unknown> = {}) => createWorkdaySwissParser({
    companyKey: 'testco',
    companyName: 'Test Co',
    companyDomain: 'testco.com',
    tenantHost: 'testco.wd3.myworkdayjobs.com',
    sitePath: 'Test_Careers',
    defaultCanton: 'ZH',
    defaultCity: 'Zurich',
    ...overrides,
  });

  function verdict(jobs: any) {
    return evaluateAuthoritativeSnapshot(jobs, {
      validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator('Test Co'),
      allowAuthoritativeEmptySnapshot: true,
      authoritativeSnapshotScope: 'empty-only',
      companyLabel: 'Test Co',
    });
  }

  it('queries the facet that holds the Swiss id (Imerys / KONE shape) and returns the Swiss postings filtered', async () => {
    const bodies = mockTenant({
      accepts: { Country: [SWISS_POSTING] },
      board: [SWISS_POSTING, FOREIGN_POSTING],
      facets: [
        { facetParameter: 'jobFamilyGroup', values: [{ id: 'eng', descriptor: 'Engineering', count: 2 }] },
        { facetParameter: 'Country', values: [FR, CH] },
      ],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(bodies.map((body) => body.appliedFacets)).toEqual([
      { locationCountry: [CH_ID] },
      {},
      { Country: [CH_ID] },
    ]);
    expect(jobs.map((job: any) => job.title)).toEqual([SWISS_POSTING.title]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('falls back to the one known country facet without a Swiss value (Ferring shape) and stamps the proven zero', async () => {
    const bodies = mockTenant({
      accepts: { Location_Country: [] },
      board: [FOREIGN_POSTING],
      boardTotal: 7,
      facets: [
        { facetParameter: 'Location_Country', values: [FR] },
        { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locations', descriptor: 'Locations', values: [{ id: 'lyon', descriptor: 'Lyon', count: 7 }] }] },
      ],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(bodies.map((body) => body.appliedFacets)).toEqual([
      { locationCountry: [CH_ID] },
      {},
      { Location_Country: [CH_ID] },
      {},
    ]);
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect((jobs as any).authoritativeEmptyEvidence).toMatch(/France/);
    expect(verdict(jobs)).toEqual({ authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true });
  });

  it('does not guess between two known country facets: whole board, bare zero', async () => {
    const bodies = mockTenant({
      accepts: { Country: [], Location_Country: [] },
      board: [FOREIGN_POSTING],
      boardTotal: 7,
      facets: [
        { facetParameter: 'Country', values: [FR] },
        { facetParameter: 'Location_Country', values: [FR] },
      ],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(bodies.map((body) => Object.keys(body.appliedFacets))).toEqual([['locationCountry'], [], []]);
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(() => verdict(jobs)).toThrow(/not a proven authoritative empty state/);
  });

  it('finds nothing on a board without a country facet (Temenos / Lombard Odier shape): whole board, bare zero', async () => {
    const bodies = mockTenant({
      accepts: {},
      board: [FOREIGN_POSTING],
      boardTotal: 7,
      facets: [
        { facetParameter: 'jobFamilyGroup', values: [{ id: 'eng', descriptor: 'Engineering', count: 7 }] },
        { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locations', descriptor: 'Locations', values: [{ id: 'lyon', descriptor: 'Lyon', count: 7 }] }] },
      ],
    });

    const jobs = await makeParser().fetchAllJobs();

    // `locationMainGroup` is a group, not a filter key: never queried.
    expect(bodies.map((body) => Object.keys(body.appliedFacets))).toEqual([['locationCountry'], [], []]);
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('never second-guesses a key the parser declared', async () => {
    const bodies = mockTenant({
      accepts: { Country: [SWISS_POSTING] },
      board: [SWISS_POSTING, FOREIGN_POSTING],
      facets: [{ facetParameter: 'Country', values: [FR, CH] }],
    });

    const jobs = await makeParser({ countryFacetParameter: 'Location' }).fetchAllJobs();

    expect(bodies.map((body) => body.appliedFacets)).toEqual([{ Location: [CH_ID] }, {}]);
    expect(jobs.map((job: any) => job.title)).toEqual([SWISS_POSTING.title]);
  });

  it('does not stamp an accepted zero when the board itself is empty (site emptied or migrated)', async () => {
    mockTenant({
      accepts: { locationCountry: [] },
      board: [],
      boardTotal: 0,
      facets: [{ facetParameter: 'locationCountry', values: [] }],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refetches through the strict gate when an accepted zero contradicts a board that lists Switzerland', async () => {
    const bodies = mockTenant({
      accepts: { locationCountry: [] },
      board: [SWISS_POSTING, FOREIGN_POSTING],
      facets: [{ facetParameter: 'locationCountry', values: [FR, CH] }],
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(bodies.map((body) => body.appliedFacets)).toEqual([{ locationCountry: [CH_ID] }, {}, {}]);
    expect(jobs.map((job: any) => job.title)).toEqual([SWISS_POSTING.title]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('neither discovers nor stamps on an anti-bot block', async () => {
    const bodies = mockTenant({
      accepts: {},
      board: [FOREIGN_POSTING],
      facets: [{ facetParameter: 'Location_Country', values: [FR] }],
      listStatus: 403,
    });

    const jobs = await makeParser().fetchAllJobs();

    expect(bodies.map((body) => body.appliedFacets)).toEqual([{ locationCountry: [CH_ID] }, {}]);
    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBe('anti_bot_block');
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });
});

describe('discoverWorkdayCountryFacet', () => {
  const CH_ID = '187134fccb084a0ea9b4b95f23890dbe';
  const leaf = (id: string, descriptor: string) => ({ id, descriptor, count: 1 });

  it('prefers the facet holding the Swiss id, at any depth, over a known name', () => {
    expect(discoverWorkdayCountryFacet({ total: 9, postingCount: 9, facets: [
      { facetParameter: 'Location_Country', values: [leaf('fr', 'France')] },
      { facetParameter: 'Location', values: [leaf(CH_ID, 'Switzerland')] },
    ] }, { rejectedParameter: 'locationCountry' })).toEqual({ facetParameter: 'Location', reason: 'swiss-value' });
    expect(discoverWorkdayCountryFacet({ total: 9, postingCount: 9, facets: [
      { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationHub', values: [leaf(CH_ID, 'Switzerland')] }] },
    ] }, { rejectedParameter: 'locationCountry' })).toEqual({ facetParameter: 'locationHub', reason: 'swiss-value' });
  });

  it('never proposes the rejected key or a facet group, and refuses ambiguity', () => {
    expect(discoverWorkdayCountryFacet({ total: 9, postingCount: 9, facets: [
      { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationCountry', values: [leaf(CH_ID, 'Switzerland')] }] },
    ] }, { rejectedParameter: 'locationCountry' })).toBeNull();
    expect(discoverWorkdayCountryFacet({ total: 9, postingCount: 9, facets: [
      { facetParameter: 'Country', values: [leaf(CH_ID, 'Switzerland')] },
      { facetParameter: 'Location', values: [leaf(CH_ID, 'Switzerland')] },
    ] }, { rejectedParameter: 'locationCountry' })).toBeNull();
    expect(discoverWorkdayCountryFacet(null, { rejectedParameter: 'locationCountry' })).toBeNull();
    expect(discoverWorkdayCountryFacet({ total: 9, postingCount: 9, facets: [] }, { rejectedParameter: 'locationCountry' })).toBeNull();
  });

  it('keeps facet groups out of the closed list of country-facet names', () => {
    expect(WORKDAY_COUNTRY_FACET_PARAMETERS).not.toContain('locationMainGroup');
    expect(WORKDAY_COUNTRY_FACET_PARAMETERS).toContain('locationCountry');
  });
});

describe('Workday factory parsers — opting out of the default-on zero proof', () => {
  // A parser that passes `proveSwissAbsentFromLiveBoard: false` must say why,
  // on the same line or the line above: an unexplained opt-out is how a live
  // board without Swiss postings goes back to an unprovable `no-jobs-parsed`.
  const LIB = join(__dirname, '..', 'scripts', 'lib');
  const parsers = readdirSync(LIB)
    .filter((name) => name.endsWith('-job-parser.mjs'))
    .map((name) => ({ name, text: readFileSync(join(LIB, name), 'utf8') }))
    .filter(({ text }) => text.includes('createWorkdaySwissParser('));

  const COMMENT_RE = /(?:\/\/|\/\*|^\s*\*)\s*\S.{7,}/;

  function unexplainedOptOuts(text: string) {
    const lines = text.split('\n');
    return lines.flatMap((line, index) => {
      if (!/proveSwissAbsentFromLiveBoard\s*:\s*false\b/.test(line)) return [];
      const sameLine = line.slice(line.search(/proveSwissAbsentFromLiveBoard/));
      if (COMMENT_RE.test(sameLine)) return [];
      if (index > 0 && COMMENT_RE.test(lines[index - 1])) return [];
      return [index + 1];
    });
  }

  it('scans the factory consumers', () => {
    expect(parsers.length).toBeGreaterThan(0);
  });

  it('flags a bare opt-out and accepts an explained one', () => {
    expect(unexplainedOptOuts('  proveSwissAbsentFromLiveBoard: false,\n')).toEqual([1]);
    expect(unexplainedOptOuts('  proveSwissAbsentFromLiveBoard: false, // board facet lists HQ only\n')).toEqual([]);
    expect(unexplainedOptOuts('  // the country facet lists HQ only\n  proveSwissAbsentFromLiveBoard: false,\n')).toEqual([]);
  });

  it('every opt-out in scripts/lib carries its reason', () => {
    const offenders = parsers.flatMap(({ name, text }) => unexplainedOptOuts(text).map((line) => `${name}:${line}`));
    expect(offenders).toEqual([]);
  });
});
