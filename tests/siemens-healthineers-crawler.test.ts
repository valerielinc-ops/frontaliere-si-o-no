import { describe, it, expect } from 'vitest';
import {
  SIEMENS_HEALTHINEERS_KEY,
  SIEMENS_HEALTHINEERS_COMPANY_NAME,
  isSiemensHealthineersJob,
  isTrustedDomain,
} from '../scripts/lib/siemens-healthineers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Siemens Healthineers crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SIEMENS_HEALTHINEERS_KEY).toBe('siemens-healthineers');
    expect(SIEMENS_HEALTHINEERS_COMPANY_NAME).toBe('Siemens Healthineers');
  });

  // ── isCompanyJob ──
  describe('isSiemensHealthineersJob', () => {
    it('matches by companyKey', () => {
      expect(isSiemensHealthineersJob({ companyKey: 'siemens-healthineers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSiemensHealthineersJob({ company: 'Siemens Healthineers' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSiemensHealthineersJob({ url: 'https://siemens-healthineers.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSiemensHealthineersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSiemensHealthineersJob(null)).toBe(false);
      expect(isSiemensHealthineersJob(undefined)).toBe(false);
      expect(isSiemensHealthineersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://siemens-healthineers.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.siemens-healthineers.com/job/456')).toBe(true);
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
      expect(slugify('Developer siemens-healthineers ch')).toBe('developer-siemens-healthineers-ch');
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
      id: 'siemens-healthineers-abc123',
      slug: 'test-position-siemens-healthineers-ch',
      slugByLocale: { en: 'test-position-siemens-healthineers-ch' },
      company: 'Siemens Healthineers',
      companyKey: 'siemens-healthineers',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://siemens-healthineers.com/jobs/test',
      source: 'Siemens Healthineers Dedicated Parser',
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
      expect(validJob.id).toMatch(/^siemens-healthineers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
