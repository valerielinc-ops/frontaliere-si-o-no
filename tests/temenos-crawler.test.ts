import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  TEMENOS_KEY,
  TEMENOS_COMPANY_NAME,
  fetchAllTemenosJobs,
  isTemenosJob,
  isTrustedDomain,
} from '../scripts/lib/temenos-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { EMPTY_OK_CRAWLERS } from '../scripts/lib/crawler-empty-ok-registry.mjs';

const SWISS_ID = '187134fccb084a0ea9b4b95f23890dbe';

function mockTemenosWorkday({ faceted, unfiltered }: { faceted: unknown; unfiltered: unknown }) {
  const calls: Array<{ body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: any = {}) => {
    const url = String(input);
    if (!url.endsWith('/jobs') || init?.method !== 'POST') {
      return new Response('', { status: 404 });
    }
    const body = JSON.parse(init.body);
    calls.push({ body });
    const filtered = Object.keys(body.appliedFacets || {}).length > 0;
    return new Response(JSON.stringify(filtered ? faceted : unfiltered), { status: 200 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Temenos crawler parser', () => {
  it('uses the tenant facet and proves a live board with no Swiss roles', async () => {
    const calls = mockTemenosWorkday({
      faceted: { total: 0, jobPostings: [], facets: [] },
      unfiltered: {
        total: 16,
        jobPostings: [],
        facets: [{
          facetParameter: 'locationMainGroup',
          values: [
            { id: 'paris', descriptor: 'Paris', count: 4 },
            { id: 'london', descriptor: 'London', count: 3 },
            { id: 'sydney', descriptor: 'Sydney', count: 2 },
            { id: 'singapore', descriptor: 'Singapore', count: 2 },
          ],
        }],
      },
    });

    const jobs = await fetchAllTemenosJobs();

    expect(calls[0].body.appliedFacets).toEqual({ locationMainGroup: [SWISS_ID] });
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(jobs).toEqual([]);
  });

  it('does not prove empty when a Swiss location descriptor is present', async () => {
    mockTemenosWorkday({
      faceted: { total: 0, jobPostings: [], facets: [] },
      unfiltered: {
        total: 16,
        jobPostings: [],
        facets: [{
          facetParameter: 'locationMainGroup',
          values: [{
            descriptor: 'Locations',
            values: [{ id: 'geneva', descriptor: 'ExCo Geneva', count: 1 }],
          }],
        }],
      },
    });

    const jobs = await fetchAllTemenosJobs();

    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(jobs).toEqual([]);
  });

  it('wires the runner to accept only a proven empty snapshot', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-temenos-jobs.mjs'), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(TEMENOS_COMPANY_NAME)');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");

    const parser = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'temenos-job-parser.mjs'), 'utf8');
    expect(parser).toContain("countryFacetParameter: 'locationMainGroup'");
    expect(parser).toContain('proveSwissAbsentFromLiveBoard: true');

    expect(EMPTY_OK_CRAWLERS.has('temenos')).toBe(false);
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TEMENOS_KEY).toBe('temenos');
    expect(TEMENOS_COMPANY_NAME).toBe('Temenos');
  });

  // ── isCompanyJob ──
  describe('isTemenosJob', () => {
    it('matches by companyKey', () => {
      expect(isTemenosJob({ companyKey: 'temenos' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTemenosJob({ company: 'Temenos' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTemenosJob({ url: 'https://temenos.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTemenosJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTemenosJob(null)).toBe(false);
      expect(isTemenosJob(undefined)).toBe(false);
      expect(isTemenosJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://temenos.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.temenos.com/job/456')).toBe(true);
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
      expect(slugify('Developer temenos ch')).toBe('developer-temenos-ch');
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
      id: 'temenos-abc123',
      slug: 'test-position-temenos-ch',
      slugByLocale: { en: 'test-position-temenos-ch' },
      company: 'Temenos',
      companyKey: 'temenos',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://temenos.com/jobs/test',
      source: 'Temenos Dedicated Parser',
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
      expect(validJob.id).toMatch(/^temenos-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
