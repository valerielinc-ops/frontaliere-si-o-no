import fs from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  EVEREST_RE_KEY,
  EVEREST_RE_COMPANY_NAME,
  fetchAllEverestReJobs,
  isEverestReJob,
  isTrustedDomain,
} from '../scripts/lib/everest-re-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

const CURRENT_WORKDAY_FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/workday/everest-re-board-2026-10-06.json', import.meta.url), 'utf8'),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Everest Re current Workday board', () => {
  it('proves a complete foreign-only board instead of returning an unproven zero', async () => {
    const listingRequests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: any = {}) => {
      const url = String(input);
      if (url.endsWith('/jobs')) {
        listingRequests.push(JSON.parse(init.body));
        return new Response(JSON.stringify(CURRENT_WORKDAY_FIXTURE.listingResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const detailPath = Object.keys(CURRENT_WORKDAY_FIXTURE.detailResponses)
        .find((path) => url.endsWith(path));
      const detail = detailPath ? CURRENT_WORKDAY_FIXTURE.detailResponses[detailPath] : null;
      return detail
        ? new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
        : new Response('', { status: 404 });
    }));

    expect(CURRENT_WORKDAY_FIXTURE.listingResponse.jobPostings.length).toBeGreaterThan(0);

    const jobs = await fetchAllEverestReJobs();

    expect(listingRequests.map((body) => body.appliedFacets)).toEqual([
      { locationCountry: ['187134fccb084a0ea9b4b95f23890dbe'] },
      {},
    ]);
    expect(jobs).toHaveLength(0);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });
});

describe('Everest Re crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EVEREST_RE_KEY).toBe('everest-re');
    expect(EVEREST_RE_COMPANY_NAME).toBe('Everest Re');
  });

  // ── isCompanyJob ──
  describe('isEverestReJob', () => {
    it('matches by companyKey', () => {
      expect(isEverestReJob({ companyKey: 'everest-re' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEverestReJob({ company: 'Everest Re' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEverestReJob({ url: 'https://everestre.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEverestReJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEverestReJob(null)).toBe(false);
      expect(isEverestReJob(undefined)).toBe(false);
      expect(isEverestReJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://everestre.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.everestre.com/job/456')).toBe(true);
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
      expect(slugify('Developer everest-re ch')).toBe('developer-everest-re-ch');
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
      id: 'everest-re-abc123',
      slug: 'test-position-everest-re-ch',
      slugByLocale: { en: 'test-position-everest-re-ch' },
      company: 'Everest Re',
      companyKey: 'everest-re',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://everestre.com/jobs/test',
      source: 'Everest Re Dedicated Parser',
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
      expect(validJob.id).toMatch(/^everest-re-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
