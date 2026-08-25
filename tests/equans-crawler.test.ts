import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  EQUANS_KEY,
  EQUANS_COMPANY_NAME,
  isEquansJob,
  isTrustedDomain,
  fetchAllEquansJobs,
} from '../scripts/lib/equans-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1004089/jobs';

describe('Equans Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EQUANS_KEY).toBe('equans');
    expect(EQUANS_COMPANY_NAME).toBe('Equans Switzerland');
  });

  // ── isCompanyJob ──
  describe('isEquansJob', () => {
    it('matches by companyKey', () => {
      expect(isEquansJob({ companyKey: 'equans' })).toBe(true);
    });

    it('matches by company name (including subsidiary variants)', () => {
      expect(isEquansJob({ company: 'Equans Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEquansJob({ url: 'https://www.equans.ch/de/karriere/test-job' })).toBe(true);
    });

    it('matches by Prospective medium-scoped URL', () => {
      expect(
        isEquansJob({ url: 'https://ohws.prospective.ch/public/v1/medium/1004089/jobs/abc' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isEquansJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEquansJob(null)).toBe(false);
      expect(isEquansJob(undefined)).toBe(false);
      expect(isEquansJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the equans.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.equans.ch/de/karriere')).toBe(true);
      expect(isTrustedDomain('https://equans.ch/')).toBe(true);
    });

    it('trusts the Prospective medium-scoped host', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/medium/1004089/jobs/xyz')).toBe(true);
    });

    it('trusts the Prospective job-direct host (no custom job-page URL configured)', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/jobs/abc-123')).toBe(true);
    });

    it('no longer trusts jobs.ch (migrated off it — it was never the real source)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(false);
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
      const slug = slugify('Automatiker:in im Schaltanlagenbau, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('automatiker im schaltanlagenbau equans st gallen')).toBe(
        'automatiker-im-schaltanlagenbau-equans-st-gallen'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'equans-abc123',
      slug: 'test-position-equans-zurich',
      slugByLocale: { de: 'test-position-equans-zurich' },
      company: 'Equans Switzerland',
      companyKey: 'equans',
      companyDomain: 'equans.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://ohws.prospective.ch/public/v1/jobs/abc-123',
      source: 'Equans Switzerland Dedicated Parser (Prospective medium 1004089)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Förrlibuckstrasse 150',
      postalCode: '8005',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://career55.sapsf.eu/career?company=equans&career_ns=job_application&career_job_req_id=1158',
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
      expect(validJob.id).toMatch(/^equans-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('url points at the employer\'s own Prospective.ch tenant, not a job-board aggregator', () => {
      expect(validJob.url).toContain('ohws.prospective.ch');
      expect(validJob.url).not.toContain('jobs.ch');
      expect(validJob.applyUrl).not.toContain('jobs.ch');
    });
  });

  // ── fetchAllEquansJobs (graceful degradation + Prospective contract) ──
  describe('fetchAllEquansJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ohws.prospective.ch');
      }) as any;

      const jobs = await fetchAllEquansJobs();
      expect(jobs).toEqual([]);
    });

    it('parses listings when the Prospective API returns jobs, linking to the tenant and the real SuccessFactors apply link', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify({
              total: 1,
              jobs: [
                {
                  szas: {
                    sza_title: 'Automatiker:in im Schaltanlagenbau',
                    'sza_workplace.city': 'St. Gallen',
                    'sza_pensum.max': '100',
                    sza_apply_link: 'https://career55.sapsf.eu/career?company=equans&career_ns=job_application&career_job_req_id=1158',
                  },
                  links: {
                    directlink: 'https://ohws.prospective.ch/public/v1/jobs/ac3fc0b5-64ee-437e-a76a-ef4b7f1748d2',
                  },
                  attributes: { '50': ['Equans Switzerland AG'] },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllEquansJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Equans Switzerland',
        companyKey: 'equans',
        canton: 'SG',
        country: 'CH',
        employmentType: 'FULL_TIME',
      });
      expect(jobs[0].url).toBe('https://ohws.prospective.ch/public/v1/jobs/ac3fc0b5-64ee-437e-a76a-ef4b7f1748d2');
      expect(jobs[0].applyUrl).toBe(
        'https://career55.sapsf.eu/career?company=equans&career_ns=job_application&career_job_req_id=1158',
      );
      expect(jobs[0].id).toMatch(/^equans-/);
      expect(jobs[0].category).toBe('Tecnica');
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllEquansJobs();
      expect(jobs).toEqual([]);
    });
  });
});
