import { describe, it, expect } from 'vitest';
import {
  APPLE_RETAIL_SWITZERLAND_KEY,
  APPLE_RETAIL_SWITZERLAND_COMPANY_NAME,
  isAppleRetailSwitzerlandJob,
  isTrustedDomain,
  resolveAppleRetailSwitzerlandCanton,
} from '../scripts/lib/apple-retail-switzerland-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Apple Retail Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APPLE_RETAIL_SWITZERLAND_KEY).toBe('apple-retail-switzerland');
    expect(APPLE_RETAIL_SWITZERLAND_COMPANY_NAME).toBe('Apple Retail Switzerland');
  });

  // ── isCompanyJob ──
  describe('isAppleRetailSwitzerlandJob', () => {
    it('matches by companyKey', () => {
      expect(isAppleRetailSwitzerlandJob({ companyKey: 'apple-retail-switzerland' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAppleRetailSwitzerlandJob({ company: 'Apple Retail Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAppleRetailSwitzerlandJob({ url: 'https://jobs.apple.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAppleRetailSwitzerlandJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAppleRetailSwitzerlandJob(null)).toBe(false);
      expect(isAppleRetailSwitzerlandJob(undefined)).toBe(false);
      expect(isAppleRetailSwitzerlandJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.apple.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.apple.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── resolveAppleRetailSwitzerlandCanton (issue #7055) ──
  describe('resolveAppleRetailSwitzerlandCanton', () => {
    it('resolves a real Swiss city to its canton', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Lugano')).toBe('TI');
    });

    it('does not route a nationwide "Switzerland" posting to a canton', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Switzerland')).toBe('');
    });

    it('falls back to ZH only when a real (unresolved) city is given', () => {
      expect(resolveAppleRetailSwitzerlandCanton('Nowhereville')).toBe('ZH');
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
      expect(slugify('Developer apple-retail-switzerland ch')).toBe('developer-apple-retail-switzerland-ch');
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
      id: 'apple-retail-switzerland-abc123',
      slug: 'test-position-apple-retail-switzerland-ch',
      slugByLocale: { de: 'test-position-apple-retail-switzerland-ch' },
      company: 'Apple Retail Switzerland',
      companyKey: 'apple-retail-switzerland',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.apple.com/jobs/test',
      source: 'Apple Retail Switzerland Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apple-retail-switzerland-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
