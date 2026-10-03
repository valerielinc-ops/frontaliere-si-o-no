import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  IMERYS_KEY,
  IMERYS_COMPANY_NAME,
  fetchAllImerysJobs,
  isImerysJob,
  isTrustedDomain,
} from '../scripts/lib/imerys-job-parser.mjs';
import { evaluateAuthoritativeSnapshot, slugify } from '../scripts/lib/crawler-template.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

// Live captures of the Imerys Workday tenant (2026-10-02), sanitized: job
// bodies replaced by neutral text, error case ids redacted.
function workdayFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'workday', name), 'utf8'));
}

type WorkdayMock = {
  faceted?: unknown;
  unfiltered?: unknown;
  details?: Record<string, unknown>;
  siteStatus?: number;
  unfilteredStatus?: number;
};

/** The tenant as it answers live: `Country` is its facet key, `locationCountry` is a 400. */
function mockImerysWorkday({ faceted, unfiltered, details = {}, siteStatus = 200, unfilteredStatus = 200 }: WorkdayMock) {
  const listCalls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: any = {}) => {
    const url = String(input);
    if (url.endsWith('/jobs') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      listCalls.push({ url, body });
      if (siteStatus !== 200) {
        return new Response(JSON.stringify(workdayFixture('unknown-site-404.json')), { status: siteStatus });
      }
      if (body.appliedFacets?.locationCountry) return new Response('{"errorCode":"HTTP_422"}', { status: 400 });
      if (Object.keys(body.appliedFacets || {}).length > 0) return new Response(JSON.stringify(faceted), { status: 200 });
      if (unfilteredStatus !== 200) return new Response('blocked', { status: unfilteredStatus });
      return new Response(JSON.stringify(unfiltered), { status: 200 });
    }
    const hit = Object.keys(details).find((p) => url.endsWith(p));
    return hit ? new Response(JSON.stringify(details[hit]), { status: 200 }) : new Response('', { status: 404 });
  }));
  return listCalls;
}

function verdict(jobs: any[]) {
  return evaluateAuthoritativeSnapshot(jobs, {
    validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(IMERYS_COMPANY_NAME),
    allowAuthoritativeEmptySnapshot: true,
    authoritativeSnapshotScope: 'empty-only',
    companyLabel: IMERYS_COMPANY_NAME,
  });
}

const EMPTY_SWISS_FACET = workdayFixture('imerys-career2-swiss-facet-empty.json');
const LIVE_BOARD_WITHOUT_CH = workdayFixture('imerys-career2-board.json');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Imerys crawler — Workday source (tenant imerys, site IMERYS-Careers)', () => {
  it('reads the Swiss board through the tenant `Country` facet and publishes the Bodio req', async () => {
    const listCalls = mockImerysWorkday({
      faceted: workdayFixture('imerys-careers-swiss-facet.json'),
      details: {
        '/job/Bodio-Switzerland/MECHANICAL-MAINTENANCE-SUPERVISOR_REQ-11824': workdayFixture('imerys-detail-bodio.json'),
      },
    });

    const jobs = await fetchAllImerysJobs();

    expect(listCalls[0].url).toBe('https://imerys.wd3.myworkdayjobs.com/wday/cxs/imerys/IMERYS-Careers/jobs');
    expect(listCalls[0].body.appliedFacets).toEqual({ Country: ['187134fccb084a0ea9b4b95f23890dbe'] });
    // Bodio merged into Giornico in 2025, so the BFS commune list no longer
    // names it; the req's structured country (CH) lets the official locality
    // directory place it. The two Bironico reqs have no detail in this mock,
    // so they carry no body and are not published.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'MECHANICAL MAINTENANCE SUPERVISOR',
      location: 'Bodio',
      canton: 'TI',
      addressCountry: 'CH',
      companyKey: 'imerys',
      url: 'https://imerys.wd3.myworkdayjobs.com/en-US/IMERYS-Careers/job/Bodio-Switzerland/MECHANICAL-MAINTENANCE-SUPERVISOR_REQ-11824',
    });
    expect(isTrustedDomain(jobs[0].url)).toBe(true);
    expect(isImerysJob(jobs[0])).toBe(true);
  });

  it('refetches the full board when the `Country` facet falsely reports zero', async () => {
    const listCalls = mockImerysWorkday({
      faceted: { total: 0, jobPostings: [] },
      unfiltered: workdayFixture('imerys-careers-swiss-facet.json'),
      details: {
        '/job/Bodio-Switzerland/MECHANICAL-MAINTENANCE-SUPERVISOR_REQ-11824': workdayFixture('imerys-detail-bodio.json'),
      },
    });

    const jobs = await fetchAllImerysJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'MECHANICAL MAINTENANCE SUPERVISOR', location: 'Bodio', canton: 'TI' });
    expect(listCalls.map((call) => call.body.appliedFacets)).toEqual([
      { Country: ['187134fccb084a0ea9b4b95f23890dbe'] },
      {},
      {},
    ]);
  });

  it('publishes a proven zero when the live board lists no Swiss value in its country facet', async () => {
    mockImerysWorkday({ faceted: EMPTY_SWISS_FACET, unfiltered: LIVE_BOARD_WITHOUT_CH });

    const jobs = await fetchAllImerysJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(Reflect.get(jobs, 'authoritativeEmptyEvidence')).toMatch(/live board 35 posting\(s\) across 9 location value\(s\) .*Switzerland not among them/);
    expect(verdict(jobs)).toEqual({ authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true });
  });

  it('fails loudly when the career site does not exist (renamed or retired site)', async () => {
    mockImerysWorkday({ siteStatus: 404 });
    await expect(fetchAllImerysJobs()).rejects.toThrow(/HTTP 404/);
  });

  it('keeps a bare zero when the site is live but holds no postings at all (a migrated board reads the same way)', async () => {
    mockImerysWorkday({
      faceted: EMPTY_SWISS_FACET,
      unfiltered: { total: 0, jobPostings: [], facets: [{ facetParameter: 'Country', values: [] }] },
    });

    const jobs = await fetchAllImerysJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(() => verdict(jobs)).toThrow(/not a proven authoritative empty state/);
  });

  it('refuses the proof when the board still lists Switzerland in its country facet', async () => {
    const withSwiss = workdayFixture('imerys-careers-swiss-facet.json').facets;
    mockImerysWorkday({ faceted: EMPTY_SWISS_FACET, unfiltered: { ...LIVE_BOARD_WITHOUT_CH, facets: withSwiss } });

    const jobs = await fetchAllImerysJobs();

    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('refuses the proof when the board summary cannot be read', async () => {
    mockImerysWorkday({ faceted: EMPTY_SWISS_FACET, unfilteredStatus: 403 });

    const jobs = await fetchAllImerysJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('wires the runner to accept only a proven empty snapshot', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-imerys-jobs.mjs'), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(IMERYS_COMPANY_NAME)');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    // The per-run proof replaces the allowlist entry, which kept masking the
    // slug while it read a dead source.
    const monitor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-crawler-health.mjs'), 'utf8');
    const allowlist = /const EMPTY_OK_CRAWLERS = new Set\(\[([\s\S]*?)\]\)/.exec(monitor);
    expect(allowlist).toBeTruthy();
    expect(allowlist![1]).not.toMatch(/^\s*'imerys',/m);
  });
});


describe('Imerys crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IMERYS_KEY).toBe('imerys');
    expect(IMERYS_COMPANY_NAME).toBe('Imerys');
  });

  // ── isCompanyJob ──
  describe('isImerysJob', () => {
    it('matches by companyKey', () => {
      expect(isImerysJob({ companyKey: 'imerys' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isImerysJob({ company: 'Imerys' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isImerysJob({ url: 'https://imerys.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isImerysJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isImerysJob(null)).toBe(false);
      expect(isImerysJob(undefined)).toBe(false);
      expect(isImerysJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://imerys.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.imerys.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer imerys ch')).toBe('developer-imerys-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'imerys-abc123',
      slug: 'test-position-imerys-ch',
      slugByLocale: { en: 'test-position-imerys-ch' },
      company: 'Imerys',
      companyKey: 'imerys',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://imerys.com/jobs/test',
      source: 'Imerys Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^imerys-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
