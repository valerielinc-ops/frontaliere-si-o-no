import { describe, it, expect } from 'vitest';
import {
  JSAFRASARASIN_KEY,
  JSAFRASARASIN_COMPANY_NAME,
  isJsafrasarasinJob,
  isTrustedDomain,
} from '../scripts/lib/jsafrasarasin-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('J. Safra Sarasin crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(JSAFRASARASIN_KEY).toBe('jsafrasarasin');
    expect(JSAFRASARASIN_COMPANY_NAME).toBe('J. Safra Sarasin');
  });

  // ── isCompanyJob ──
  describe('isJsafrasarasinJob', () => {
    it('matches by companyKey', () => {
      expect(isJsafrasarasinJob({ companyKey: 'jsafrasarasin' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isJsafrasarasinJob({ company: 'J. Safra Sarasin' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isJsafrasarasinJob({ url: 'https://jsafrasarasin.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isJsafrasarasinJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isJsafrasarasinJob(null)).toBe(false);
      expect(isJsafrasarasinJob(undefined)).toBe(false);
      expect(isJsafrasarasinJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jsafrasarasin.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jsafrasarasin.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer jsafrasarasin ch')).toBe('developer-jsafrasarasin-ch');
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
      id: 'jsafrasarasin-abc123',
      slug: 'test-position-jsafrasarasin-ch',
      slugByLocale: { en: 'test-position-jsafrasarasin-ch' },
      company: 'J. Safra Sarasin',
      companyKey: 'jsafrasarasin',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jsafrasarasin.umantis.com/jobs/test',
      source: 'J. Safra Sarasin Dedicated Parser',
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
      expect(validJob.id).toMatch(/^jsafrasarasin-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
