import { describe, it, expect } from 'vitest';
import {
  SWISS_EDUCATION_COMPANY_CH_KEY,
  SWISS_EDUCATION_COMPANY_CH_COMPANY_NAME,
  isSwissEducationCompanyChJob,
  isTrustedDomain,
} from '../scripts/lib/swiss-education-company-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Swiss Education Company GmbH crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISS_EDUCATION_COMPANY_CH_KEY).toBe('swiss-education-company-ch');
    expect(SWISS_EDUCATION_COMPANY_CH_COMPANY_NAME).toBe('Swiss Education Company GmbH');
  });

  // ── isCompanyJob ──
  describe('isSwissEducationCompanyChJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissEducationCompanyChJob({ companyKey: 'swiss-education-company-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissEducationCompanyChJob({ company: 'Swiss Education Company GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissEducationCompanyChJob({ url: 'https://swiss-education-company.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissEducationCompanyChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissEducationCompanyChJob(null)).toBe(false);
      expect(isSwissEducationCompanyChJob(undefined)).toBe(false);
      expect(isSwissEducationCompanyChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swiss-education-company.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swiss-education-company.ch/job/456')).toBe(true);
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
      expect(slugify('Developer swiss-education-company-ch ch')).toBe('developer-swiss-education-company-ch-ch');
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
      id: 'swiss-education-company-ch-abc123',
      slug: 'test-position-swiss-education-company-ch-ch',
      slugByLocale: { de: 'test-position-swiss-education-company-ch-ch' },
      company: 'Swiss Education Company GmbH',
      companyKey: 'swiss-education-company-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swiss-education-company.ch/jobs/test',
      source: 'Swiss Education Company GmbH Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^swiss-education-company-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
