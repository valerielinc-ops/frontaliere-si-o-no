import { describe, it, expect } from 'vitest';
import {
  COMPANY_KEY,
  COMPANY_COMPANY_NAME,
  isCompanyJob,
  isTrustedDomain,
} from '../scripts/lib/company-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('elvetino crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(COMPANY_KEY).toBe('company');
    expect(COMPANY_COMPANY_NAME).toBe('elvetino');
  });

  // ── isCompanyJob ──
  describe('isCompanyJob', () => {
    it('matches by companyKey', () => {
      expect(isCompanyJob({ companyKey: 'company' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCompanyJob({ company: 'elvetino' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCompanyJob({ url: 'https://company.sbb.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCompanyJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCompanyJob(null)).toBe(false);
      expect(isCompanyJob(undefined)).toBe(false);
      expect(isCompanyJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://company.sbb.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.company.sbb.ch/job/456')).toBe(true);
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
      expect(slugify('Developer company ch')).toBe('developer-company-ch');
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
      id: 'company-abc123',
      slug: 'test-position-company-ch',
      slugByLocale: { de: 'test-position-company-ch' },
      company: 'elvetino',
      companyKey: 'company',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://company.sbb.ch/jobs/test',
      source: 'elvetino Dedicated Parser',
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
      expect(validJob.id).toMatch(/^company-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
