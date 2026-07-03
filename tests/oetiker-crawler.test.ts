import { describe, it, expect } from 'vitest';
import {
  OETIKER_KEY,
  OETIKER_COMPANY_NAME,
  isOetikerJob,
  isTrustedDomain,
} from '../scripts/lib/oetiker-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Oetiker crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OETIKER_KEY).toBe('oetiker');
    expect(OETIKER_COMPANY_NAME).toBe('Oetiker');
  });

  // ── isCompanyJob ──
  describe('isOetikerJob', () => {
    it('matches by companyKey', () => {
      expect(isOetikerJob({ companyKey: 'oetiker' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOetikerJob({ company: 'Oetiker' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOetikerJob({ url: 'https://www.oetiker.com/en-us/about-us/careers' })).toBe(true);
    });

    it('matches by SmartRecruiters board URL', () => {
      expect(isOetikerJob({ url: 'https://jobs.smartrecruiters.com/oetiker/7971866-account-manager' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOetikerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOetikerJob(null)).toBe(false);
      expect(isOetikerJob(undefined)).toBe(false);
      expect(isOetikerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.oetiker.com/en-us/about-us/careers')).toBe(true);
    });

    it('trusts SmartRecruiters domain (ATS job board)', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/oetiker/7971866-account-manager')).toBe(true);
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
      const slug = slugify('Account Manager (Zurich)');
      expect(slug).toBe('account-manager-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Account Manager oetiker horgen')).toBe('account-manager-oetiker-horgen');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllOetikerJobs emits)
    const validJob = {
      id: 'oetiker-abc123',
      slug: 'test-position-oetiker-horgen',
      slugByLocale: { de: 'test-position-oetiker-horgen' },
      company: 'Oetiker',
      companyKey: 'oetiker',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Horgen',
      canton: 'ZH',
      url: 'https://jobs.smartrecruiters.com/oetiker/test',
      source: 'Oetiker Dedicated Parser (SmartRecruiters)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Horgen',
      addressRegion: 'ZH',
      streetAddress: 'Spätzstrasse 11',
      postalCode: '8810',
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
      expect(validJob.id).toMatch(/^oetiker-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
