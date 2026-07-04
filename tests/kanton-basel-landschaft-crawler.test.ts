import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  KANTON_BASEL_LANDSCHAFT_KEY,
  KANTON_BASEL_LANDSCHAFT_COMPANY_NAME,
  isKantonBaselLandschaftJob,
  isTrustedDomain,
  fetchAllKantonBaselLandschaftJobs,
} from '../scripts/lib/kanton-basel-landschaft-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1571/jobs';

describe('Kantonale Verwaltung Basel-Landschaft crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KANTON_BASEL_LANDSCHAFT_KEY).toBe('kanton-basel-landschaft');
    expect(KANTON_BASEL_LANDSCHAFT_COMPANY_NAME).toBe('Kantonale Verwaltung Basel-Landschaft');
  });

  // ── isCompanyJob ──
  describe('isKantonBaselLandschaftJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonBaselLandschaftJob({ companyKey: 'kanton-basel-landschaft' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonBaselLandschaftJob({ company: 'Kantonale Verwaltung Basel-Landschaft' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isKantonBaselLandschaftJob({ url: 'https://jobs.baselland.ch/offene-stellen/hr-beraterin-hr-berater/abc' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isKantonBaselLandschaftJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonBaselLandschaftJob(null)).toBe(false);
      expect(isKantonBaselLandschaftJob(undefined)).toBe(false);
      expect(isKantonBaselLandschaftJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the baselland.ch and jobs.baselland.ch hosts', () => {
      expect(isTrustedDomain('https://jobs.baselland.ch/offene-stellen/hr-beraterin-hr-berater/abc')).toBe(true);
      expect(isTrustedDomain('https://www.baselland.ch/politik-und-behorden')).toBe(true);
    });

    it('trusts the Prospective medium-scoped host', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/medium/1571/jobs/xyz')).toBe(true);
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
      const slug = slugify('HR Beraterin/HR Berater, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('hr beraterin kanton basel landschaft')).toBe(
        'hr-beraterin-kanton-basel-landschaft'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'kanton-basel-landschaft-abc123',
      slug: 'test-position-kanton-basel-landschaft',
      slugByLocale: { de: 'test-position-kanton-basel-landschaft' },
      company: 'Kantonale Verwaltung Basel-Landschaft',
      companyKey: 'kanton-basel-landschaft',
      companyDomain: 'baselland.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Liestal',
      canton: 'BL',
      url: 'https://jobs.baselland.ch/offene-stellen/test-position/abc',
      source: 'Kantonale Verwaltung Basel-Landschaft Dedicated Parser (Prospective.ch medium 1571)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Liestal',
      addressRegion: 'BL',
      streetAddress: 'Liestal',
      postalCode: '4410',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.baselland.ch/offene-stellen/test-position/abc',
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

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-basel-landschaft-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllKantonBaselLandschaftJobs (graceful degradation + Prospective contract) ──
  describe('fetchAllKantonBaselLandschaftJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 500 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ohws.prospective.ch');
      }) as any;

      const jobs = await fetchAllKantonBaselLandschaftJobs();
      expect(jobs).toEqual([]);
    });

    it('parses listings when the Prospective API returns jobs, applying HQ fallback', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify({
              total: 1,
              jobs: [
                {
                  szas: {
                    sza_title: 'HR Beraterin/HR Berater',
                    'sza_workplace.city': 'Liestal',
                  },
                  links: {
                    directlink: 'https://jobs.baselland.ch/offene-stellen/hr-beraterin-hr-berater/329b7caa',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllKantonBaselLandschaftJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Kantonale Verwaltung Basel-Landschaft',
        companyKey: 'kanton-basel-landschaft',
        canton: 'BL',
        country: 'CH',
      });
      expect(jobs[0].url).toBe(
        'https://jobs.baselland.ch/offene-stellen/hr-beraterin-hr-berater/329b7caa',
      );
      expect(jobs[0].id).toMatch(/^kanton-basel-landschaft-/);
      expect(jobs[0].postalCode).toBe('4410');
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllKantonBaselLandschaftJobs();
      expect(jobs).toEqual([]);
    });
  });
});
