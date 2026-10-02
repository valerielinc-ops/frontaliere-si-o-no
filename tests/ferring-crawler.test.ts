import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  FERRING_KEY,
  FERRING_COMPANY_NAME,
  fetchAllFerringJobs,
  isFerringJob,
  isTrustedDomain,
} from '../scripts/lib/ferring-job-parser.mjs';
import { evaluateAuthoritativeSnapshot, slugify } from '../scripts/lib/crawler-template.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

// Live captures of the Ferring Workday board (2026-10-02), facets only.
function workdayFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'workday', name), 'utf8'));
}

/** The tenant as it answers live: only `Location_Country` is a facet key. */
function mockFerringWorkday(unfiltered: unknown, { siteStatus = 200 } = {}) {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: any = {}) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (siteStatus !== 200) return new Response(JSON.stringify(workdayFixture('unknown-site-404.json')), { status: siteStatus });
    const keys = Object.keys(body.appliedFacets || {});
    if (keys.some((k) => k !== 'Location_Country')) return new Response('{"errorCode":"HTTP_422"}', { status: 400 });
    if (keys.length > 0) return new Response(JSON.stringify(workdayFixture('ferring-swiss-facet-empty.json')), { status: 200 });
    return new Response(JSON.stringify(unfiltered), { status: 200 });
  }));
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ferring — source-proven Swiss zero instead of an EMPTY_OK_CRAWLERS entry', () => {
  it('queries the `Location_Country` facet and proves the zero on the live board', async () => {
    const bodies = mockFerringWorkday(workdayFixture('ferring-board.json'));

    const jobs = await fetchAllFerringJobs();

    expect(bodies[0].appliedFacets).toEqual({ Location_Country: ['187134fccb084a0ea9b4b95f23890dbe'] });
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(Reflect.get(jobs, 'authoritativeEmptyEvidence')).toMatch(/live board 54 posting\(s\) in 20 countries .*Switzerland not among them/);
    expect(evaluateAuthoritativeSnapshot(jobs, {
      validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(FERRING_COMPANY_NAME),
      allowAuthoritativeEmptySnapshot: true,
      authoritativeSnapshotScope: 'empty-only',
      companyLabel: FERRING_COMPANY_NAME,
    })).toEqual({ authoritativeSnapshotVerified: true, authoritativeEmptySnapshot: true });
  });

  it('keeps a bare zero when the board itself is empty, and fails on a missing site', async () => {
    mockFerringWorkday({ total: 0, jobPostings: [], facets: [{ facetParameter: 'Location_Country', values: [] }] });
    expect(isAuthoritativeEmptySnapshot(await fetchAllFerringJobs())).toBe(false);

    mockFerringWorkday(null, { siteStatus: 404 });
    await expect(fetchAllFerringJobs()).rejects.toThrow(/HTTP 404/);
  });

  it('wires the runner to the proof and leaves the allowlist', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-ferring-jobs.mjs'), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(FERRING_COMPANY_NAME)');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    const monitor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-crawler-health.mjs'), 'utf8');
    const allowlist = /const EMPTY_OK_CRAWLERS = new Set\(\[([\s\S]*?)\]\)/.exec(monitor);
    expect(allowlist).toBeTruthy();
    expect(allowlist![1]).not.toMatch(/^\s*'ferring',/m);
  });
});


describe('Ferring Pharmaceuticals crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FERRING_KEY).toBe('ferring');
    expect(FERRING_COMPANY_NAME).toBe('Ferring Pharmaceuticals');
  });

  // ── isCompanyJob ──
  describe('isFerringJob', () => {
    it('matches by companyKey', () => {
      expect(isFerringJob({ companyKey: 'ferring' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFerringJob({ company: 'Ferring Pharmaceuticals' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFerringJob({ url: 'https://ferring.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFerringJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFerringJob(null)).toBe(false);
      expect(isFerringJob(undefined)).toBe(false);
      expect(isFerringJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ferring.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ferring.com/job/456')).toBe(true);
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
      expect(slugify('Developer ferring ch')).toBe('developer-ferring-ch');
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
      id: 'ferring-abc123',
      slug: 'test-position-ferring-ch',
      slugByLocale: { en: 'test-position-ferring-ch' },
      company: 'Ferring Pharmaceuticals',
      companyKey: 'ferring',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ferring.com/jobs/test',
      source: 'Ferring Pharmaceuticals Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ferring-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
