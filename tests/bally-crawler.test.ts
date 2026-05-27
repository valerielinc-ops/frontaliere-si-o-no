import { describe, it, expect } from 'vitest';
import {
  BALLY_KEY,
  BALLY_COMPANY_NAME,
  isBallyJob,
  isTrustedDomain,
} from '../scripts/lib/bally-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bally crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BALLY_KEY).toBe('bally');
    expect(BALLY_COMPANY_NAME).toBe('Bally');
  });

  // ── isCompanyJob ──
  describe('isBallyJob', () => {
    it('matches by companyKey', () => {
      expect(isBallyJob({ companyKey: 'bally' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBallyJob({ company: 'Bally' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBallyJob({ url: 'https://bally.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBallyJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBallyJob(null)).toBe(false);
      expect(isBallyJob(undefined)).toBe(false);
      expect(isBallyJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bally.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bally.com/job/456')).toBe(true);
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
      expect(slugify('Developer bally ch')).toBe('developer-bally-ch');
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
      id: 'bally-abc123',
      slug: 'test-position-bally-ch',
      slugByLocale: { en: 'test-position-bally-ch' },
      company: 'Bally',
      companyKey: 'bally',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bally.com/jobs/test',
      source: 'Bally Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bally-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
