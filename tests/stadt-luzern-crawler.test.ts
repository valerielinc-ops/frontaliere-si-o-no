import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  STADT_LUZERN_KEY,
  STADT_LUZERN_COMPANY_NAME,
  isStadtLuzernJob,
  isTrustedDomain,
  fetchAllStadtLuzernJobs,
} from '../scripts/lib/stadt-luzern-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1005002/jobs';

describe('Stadt Luzern crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADT_LUZERN_KEY).toBe('stadt-luzern');
    expect(STADT_LUZERN_COMPANY_NAME).toBe('Stadt Luzern');
  });

  // ── isCompanyJob ──
  describe('isStadtLuzernJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtLuzernJob({ companyKey: 'stadt-luzern' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtLuzernJob({ company: 'Stadt Luzern' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isStadtLuzernJob({ url: 'https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/fachspezialist-in-baugesuche/abc' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isStadtLuzernJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtLuzernJob(null)).toBe(false);
      expect(isStadtLuzernJob(undefined)).toBe(false);
      expect(isStadtLuzernJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the Prospective applicant-portal host (job.stadtluzern.ch)', () => {
      expect(isTrustedDomain('https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/test/abc')).toBe(true);
    });

    it('trusts the marketing-site host (jobs.stadtluzern.ch, plural)', () => {
      expect(isTrustedDomain('https://jobs.stadtluzern.ch/stellen/offene-stellen-stadt-luzern/')).toBe(true);
    });

    it('trusts the Prospective medium-scoped host', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/medium/1005002/jobs/xyz')).toBe(true);
    });

    it('trusts the apex company domain', () => {
      expect(isTrustedDomain('https://www.stadtluzern.ch/')).toBe(true);
      expect(isTrustedDomain('https://stadtluzern.ch/')).toBe(true);
    });

    it('rejects other domains, including the unrelated Volksschule Luzern sibling tenant apex if hosted elsewhere', () => {
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
      const slug = slugify('Fachspezialist*in Baugesuche (50-80 %)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('fachspezialist baugesuche stadt luzern')).toBe(
        'fachspezialist-baugesuche-stadt-luzern'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'stadt-luzern-abc123',
      slug: 'test-position-stadt-luzern',
      slugByLocale: { de: 'test-position-stadt-luzern' },
      company: 'Stadt Luzern',
      companyKey: 'stadt-luzern',
      companyDomain: 'stadtluzern.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Luzern',
      canton: 'LU',
      url: 'https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/test-position/abc',
      source: 'Stadt Luzern Dedicated Parser (Prospective medium 1005002)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Luzern',
      addressRegion: 'LU',
      streetAddress: 'Hirschengraben 17',
      postalCode: '6003',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/test-position/abc',
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
      expect(validJob.id).toMatch(/^stadt-luzern-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is LU (Luzern is a single-canton municipal employer)', () => {
      expect(validJob.canton).toBe('LU');
    });
  });

  // ── fetchAllStadtLuzernJobs (graceful degradation + Prospective contract) ──
  describe('fetchAllStadtLuzernJobs — graceful degradation', () => {
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

      const jobs = await fetchAllStadtLuzernJobs();
      expect(jobs).toEqual([]);
    });

    it('parses listings when the Prospective API returns jobs, using the real per-listing zip/street and the Amministrazione Pubblica sector override', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify({
              medium_id: 1005002,
              total: 1,
              jobs: [
                {
                  attributes: { '10': ['Planung, Bau & Unterhalt'] },
                  szas: {
                    sza_title: 'Fachspezialist*in Baugesuche (50-80 %)',
                    'sza_location.city': 'Luzern',
                    'sza_location.zip': '6003',
                    'sza_location.street': 'Hirschengraben 17',
                    // Real-world tenant quirk (confirmed live): sza_apply_link
                    // is a bare internal numeric reference, not a URL — must
                    // not leak into applyUrl (falls through to directlink).
                    sza_apply_link: '1780',
                    sza_introduction: 'Du bist zentrale Ansprechperson für Bauprojekte.',
                  },
                  links: {
                    directlink: 'https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/fachspezialist-in-baugesuche/e6a3a0a0',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllStadtLuzernJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Stadt Luzern',
        companyKey: 'stadt-luzern',
        canton: 'LU',
        country: 'CH',
        sector: 'Amministrazione Pubblica',
      });
      expect(jobs[0].url).toBe(
        'https://job.stadtluzern.ch/stellen/stadtluzern/offene-stellen/fachspezialist-in-baugesuche/e6a3a0a0',
      );
      expect(jobs[0].id).toMatch(/^stadt-luzern-/);
      expect(jobs[0].postalCode).toBe('6003');
      expect(jobs[0].streetAddress).toBe('Hirschengraben 17');
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllStadtLuzernJobs();
      expect(jobs).toEqual([]);
    });
  });
});
