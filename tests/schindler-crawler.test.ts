import { describe, it, expect } from 'vitest';
import {
  SCHINDLER_KEY,
  SCHINDLER_COMPANY_NAME,
  isSchindlerJob,
  isTrustedDomain,
} from '../scripts/lib/schindler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Schindler crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SCHINDLER_KEY).toBe('schindler');
    expect(SCHINDLER_COMPANY_NAME).toBe('Schindler');
  });

  // ── isCompanyJob ──
  describe('isSchindlerJob', () => {
    it('matches by companyKey', () => {
      expect(isSchindlerJob({ companyKey: 'schindler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSchindlerJob({ company: 'Schindler' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSchindlerJob({ url: 'https://schindler.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSchindlerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSchindlerJob(null)).toBe(false);
      expect(isSchindlerJob(undefined)).toBe(false);
      expect(isSchindlerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://schindler.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.schindler.ch/job/456')).toBe(true);
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
      expect(slugify('Developer schindler ch')).toBe('developer-schindler-ch');
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
      id: 'schindler-abc123',
      slug: 'test-position-schindler-ch',
      slugByLocale: { it: 'test-position-schindler-ch' },
      company: 'Schindler',
      companyKey: 'schindler',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://schindler.ch/jobs/test',
      source: 'Schindler Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^schindler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
