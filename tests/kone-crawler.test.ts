import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  KONE_KEY,
  KONE_COMPANY_NAME,
  fetchAllKoneJobs,
  isKoneJob,
  isTrustedDomain,
} from '../scripts/lib/kone-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

// Live captures of the KONE Workday tenant (2026-10-02), sanitized: job bodies
// replaced by neutral text.
function workdayFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'workday', name), 'utf8'));
}

const SWISS_FACET = workdayFixture('kone-careers-swiss-facet.json');
const SWISS_ID = '187134fccb084a0ea9b4b95f23890dbe';

/** The tenant as it answers live: `Country` is its facet key, `locationCountry` is a 400. */
function mockKoneWorkday({ faceted, unfiltered, details = {}, siteStatus = 200 }: {
  faceted?: unknown;
  unfiltered?: unknown;
  details?: Record<string, unknown>;
  siteStatus?: number;
}) {
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
      const facetApplied = Object.keys(body.appliedFacets || {}).length > 0;
      return new Response(JSON.stringify(facetApplied ? faceted : unfiltered), { status: 200 });
    }
    const hit = Object.keys(details).find((p) => url.endsWith(p));
    return hit ? new Response(JSON.stringify(details[hit]), { status: 200 }) : new Response('', { status: 404 });
  }));
  return listCalls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KONE crawler — Workday source (tenant kone, site Careers)', () => {
  it('reads the Swiss board through `Country` and publishes the req at its own workplace', async () => {
    const listCalls = mockKoneWorkday({
      faceted: SWISS_FACET,
      details: {
        '/job/Lausanne/Conseiller-re-de-vente-Modernisation---Suisse-romande_R0665148': workdayFixture('kone-detail-lausanne-rollup.json'),
        '/job/Brttisellen/Sachbearbeiter-in-HR-People---Communications-Generalist-50-_R0663358': workdayFixture('kone-detail-bruttisellen-part-time.json'),
      },
    });

    const jobs = await fetchAllKoneJobs();

    expect(listCalls[0].url).toBe('https://kone.wd3.myworkdayjobs.com/wday/cxs/kone/Careers/jobs');
    expect(listCalls[0].body.appliedFacets).toEqual({ Country: [SWISS_ID] });
    const byTitle = Object.fromEntries(jobs.map((j: any) => [j.title, j]));
    expect(Object.keys(byTitle).sort()).toEqual([
      'Conseiller/ère de vente Modernisation - Suisse romande',
      'Sachbearbeiter‧in HR People & Communications Generalist 50%',
    ]);
    // The "2 Locations" roll-up is published at the req's primary workplace.
    expect(byTitle['Conseiller/ère de vente Modernisation - Suisse romande']).toMatchObject({
      location: 'Lausanne',
      canton: 'VD',
    });
    // Brüttisellen is a locality of Wangen-Brüttisellen, not a BFS commune:
    // the structured country CH lets the official directory place it in ZH.
    // The detail's `timeType` ("Part time") sets the contract the listing
    // row cannot carry.
    expect(byTitle['Sachbearbeiter‧in HR People & Communications Generalist 50%']).toMatchObject({
      location: 'Brüttisellen',
      canton: 'ZH',
      employmentType: 'PART_TIME',
      contract: 'part-time',
    });
    for (const job of jobs) {
      expect(isTrustedDomain(job.url)).toBe(true);
      expect(isKoneJob(job)).toBe(true);
    }
  });

  it('publishes a proven zero only when the live board lists no Swiss value', async () => {
    const countries = SWISS_FACET.facets[0].values.filter((v: any) => v.id !== SWISS_ID);
    mockKoneWorkday({
      faceted: { total: 0, jobPostings: [], facets: [] },
      unfiltered: { total: 877, jobPostings: [], facets: [{ facetParameter: 'Country', values: countries }] },
    });
    const jobs = await fetchAllKoneJobs();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);

    mockKoneWorkday({
      faceted: { total: 0, jobPostings: [], facets: [] },
      unfiltered: { total: 883, jobPostings: [], facets: SWISS_FACET.facets },
    });
    expect(isAuthoritativeEmptySnapshot(await fetchAllKoneJobs())).toBe(false);
  });

  it('fails loudly when the career site does not exist', async () => {
    mockKoneWorkday({ siteStatus: 404 });
    await expect(fetchAllKoneJobs()).rejects.toThrow(/HTTP 404/);
  });

  it('wires the runner to accept only a proven empty snapshot', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-kone-jobs.mjs'), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(KONE_COMPANY_NAME)');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    // The per-run proof replaces the allowlist entry, which kept masking the
    // slug while it read a dead source.
    const monitor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-crawler-health.mjs'), 'utf8');
    const allowlist = /const EMPTY_OK_CRAWLERS = new Set\(\[([\s\S]*?)\]\)/.exec(monitor);
    expect(allowlist).toBeTruthy();
    expect(allowlist![1]).not.toMatch(/^\s*'kone',/m);
  });
});


describe('KONE crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KONE_KEY).toBe('kone');
    expect(KONE_COMPANY_NAME).toBe('KONE');
  });

  // ── isCompanyJob ──
  describe('isKoneJob', () => {
    it('matches by companyKey', () => {
      expect(isKoneJob({ companyKey: 'kone' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKoneJob({ company: 'KONE' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKoneJob({ url: 'https://kone.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKoneJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKoneJob(null)).toBe(false);
      expect(isKoneJob(undefined)).toBe(false);
      expect(isKoneJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kone.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.kone.com/job/456')).toBe(true);
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
      expect(slugify('Developer kone ch')).toBe('developer-kone-ch');
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
      id: 'kone-abc123',
      slug: 'test-position-kone-ch',
      slugByLocale: { en: 'test-position-kone-ch' },
      company: 'KONE',
      companyKey: 'kone',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://kone.com/jobs/test',
      source: 'KONE Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kone-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
