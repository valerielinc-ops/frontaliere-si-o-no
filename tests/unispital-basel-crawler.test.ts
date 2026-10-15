import { describe, it, expect } from 'vitest';
import {
  UNISPITAL_BASEL_KEY,
  UNISPITAL_BASEL_COMPANY_NAME,
  isUnispitalBaselJob,
  isTrustedDomain,
} from '../scripts/lib/unispital-basel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Universitätsspital Basel crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UNISPITAL_BASEL_KEY).toBe('unispital-basel');
    expect(UNISPITAL_BASEL_COMPANY_NAME).toBe('Universitätsspital Basel');
  });

  // ── isCompanyJob ──
  describe('isUnispitalBaselJob', () => {
    it('matches by companyKey', () => {
      expect(isUnispitalBaselJob({ companyKey: 'unispital-basel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUnispitalBaselJob({ company: 'Universitätsspital Basel' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUnispitalBaselJob({ url: 'https://unispital-basel.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUnispitalBaselJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUnispitalBaselJob(null)).toBe(false);
      expect(isUnispitalBaselJob(undefined)).toBe(false);
      expect(isUnispitalBaselJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://unispital-basel.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.unispital-basel.ch/job/456')).toBe(true);
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
      expect(slugify('Developer unispital-basel ch')).toBe('developer-unispital-basel-ch');
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
      id: 'unispital-basel-abc123',
      slug: 'test-position-unispital-basel-ch',
      slugByLocale: { de: 'test-position-unispital-basel-ch' },
      company: 'Universitätsspital Basel',
      companyKey: 'unispital-basel',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://unispital-basel.ch/jobs/test',
      source: 'Universitätsspital Basel Dedicated Parser',
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
      expect(validJob.id).toMatch(/^unispital-basel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
