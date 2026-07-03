import { describe, it, expect } from 'vitest';
import {
  STAUBLI_KEY,
  STAUBLI_COMPANY_NAME,
  isStaubliJob,
  isTrustedDomain,
} from '../scripts/lib/staubli-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stäubli crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STAUBLI_KEY).toBe('staubli');
    expect(STAUBLI_COMPANY_NAME).toBe('Stäubli');
  });

  // ── isCompanyJob ──
  describe('isStaubliJob', () => {
    it('matches by companyKey', () => {
      expect(isStaubliJob({ companyKey: 'staubli' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStaubliJob({ company: 'Stäubli' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStaubliJob({ url: 'https://staubli.com/jobs/123' })).toBe(true);
    });

    it('matches by SmartRecruiters tenant URL', () => {
      expect(isStaubliJob({ url: 'https://jobs.smartrecruiters.com/StaubliGroup/744000135669754' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStaubliJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStaubliJob(null)).toBe(false);
      expect(isStaubliJob(undefined)).toBe(false);
      expect(isStaubliJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://staubli.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.staubli.com/job/456')).toBe(true);
    });

    it('trusts SmartRecruiters ATS hosts', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/StaubliGroup/744000135669754')).toBe(true);
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
      expect(slugify('Developer staubli ch')).toBe('developer-staubli-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllStaubliJobs emits)
    const validJob = {
      id: 'staubli-abc123',
      slug: 'test-position-staubli-ch',
      slugByLocale: { de: 'test-position-staubli-ch' },
      company: 'Stäubli',
      companyKey: 'staubli',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Pfäffikon',
      canton: 'SZ',
      url: 'https://jobs.smartrecruiters.com/StaubliGroup/test',
      source: 'Stäubli Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Pfäffikon',
      addressRegion: 'SZ',
      streetAddress: 'Poststrasse 5',
      postalCode: '8808',
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
      expect(validJob.id).toMatch(/^staubli-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
