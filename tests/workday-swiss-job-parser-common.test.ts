import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createWorkdaySwissParser,
  resolveWorkdayPrimarySwissLocation,
  workdayStructuredForeignPrimaryCountry,
  isCompleteWorkdayBoard,
} from '../scripts/lib/workday-swiss-job-parser-common.mjs';
import { fetchWorkdayJobs } from '../scripts/lib/ats-clients/workday-client.mjs';
import { evaluateAuthoritativeSnapshot } from '../scripts/lib/crawler-template.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

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
          jobDescription: '<p>Detailed role description with enough content for a realistic vacancy, including responsibilities, required qualifications, team context, and practical application information.</p>',
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
          jobDescription: '<p>Detailed role description with responsibilities, qualifications, team context, and practical application information.</p>',
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
          jobDescription: '<p>Detailed role description with responsibilities, qualifications, team context, and practical application information.</p>',
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
      return new Response('', { status: 404 });
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
      return new Response('', { status: 404 });
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
          jobDescription: '<p>Swiss role</p>',
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
