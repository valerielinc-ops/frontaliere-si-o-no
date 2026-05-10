import { describe, it, expect } from 'vitest';
import {
  NESTLE_KEY,
  NESTLE_COMPANY_NAME,
  isNestleJob,
  isTrustedDomain,
} from '../scripts/lib/nestle-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Nestlé crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NESTLE_KEY).toBe('nestle');
    expect(NESTLE_COMPANY_NAME).toBe('Nestlé');
  });

  // ── isCompanyJob ──
  describe('isNestleJob', () => {
    it('matches by companyKey', () => {
      expect(isNestleJob({ companyKey: 'nestle' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNestleJob({ company: 'Nestlé' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNestleJob({ url: 'https://nestle.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNestleJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNestleJob(null)).toBe(false);
      expect(isNestleJob(undefined)).toBe(false);
      expect(isNestleJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nestle.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nestle.ch/job/456')).toBe(true);
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
      expect(slugify('Developer nestle ch')).toBe('developer-nestle-ch');
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
      id: 'nestle-abc123',
      slug: 'test-position-nestle-ch',
      slugByLocale: { it: 'test-position-nestle-ch' },
      company: 'Nestlé',
      companyKey: 'nestle',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nestle.ch/jobs/test',
      source: 'Nestlé Dedicated Parser',
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
      expect(validJob.id).toMatch(/^nestle-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
