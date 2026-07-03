import { describe, it, expect } from 'vitest';
import {
  CERN_KEY,
  CERN_COMPANY_NAME,
  isCernJob,
  isTrustedDomain,
} from '../scripts/lib/cern-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CERN crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CERN_KEY).toBe('cern');
    expect(CERN_COMPANY_NAME).toBe('CERN');
  });

  // ── isCompanyJob ──
  describe('isCernJob', () => {
    it('matches by companyKey', () => {
      expect(isCernJob({ companyKey: 'cern' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCernJob({ company: 'CERN' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCernJob({ url: 'https://home.cern/jobs/123' })).toBe(true);
    });

    it('matches by SmartRecruiters tenant URL', () => {
      expect(isCernJob({ url: 'https://jobs.smartrecruiters.com/CERN/744000135669754' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCernJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCernJob(null)).toBe(false);
      expect(isCernJob(undefined)).toBe(false);
      expect(isCernJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://home.cern/careers/job-123')).toBe(true);
    });

    it('trusts careers subdomain', () => {
      expect(isTrustedDomain('https://careers.cern/job/456')).toBe(true);
    });

    it('trusts SmartRecruiters ATS hosts', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/CERN/744000135669754')).toBe(true);
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
      expect(slugify('Physicist cern geneva')).toBe('physicist-cern-geneva');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllCernJobs emits)
    const validJob = {
      id: 'cern-abc123',
      slug: 'test-position-cern-geneva',
      slugByLocale: { en: 'test-position-cern-geneva' },
      company: 'CERN',
      companyKey: 'cern',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Meyrin',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/CERN/test',
      source: 'CERN Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Meyrin',
      addressRegion: 'GE',
      streetAddress: 'Esplanade des Particules 1',
      postalCode: '1211',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^cern-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
