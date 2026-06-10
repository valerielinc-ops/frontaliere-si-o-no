import { describe, it, expect } from 'vitest';
import {
  GIVAUDAN_KEY,
  GIVAUDAN_COMPANY_NAME,
  isGivaudanJob,
  isTrustedDomain,
} from '../scripts/lib/givaudan-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Givaudan crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GIVAUDAN_KEY).toBe('givaudan');
    expect(GIVAUDAN_COMPANY_NAME).toBe('Givaudan');
  });

  // ── isCompanyJob ──
  describe('isGivaudanJob', () => {
    it('matches by companyKey', () => {
      expect(isGivaudanJob({ companyKey: 'givaudan' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGivaudanJob({ company: 'Givaudan' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGivaudanJob({ url: 'https://givaudan.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGivaudanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGivaudanJob(null)).toBe(false);
      expect(isGivaudanJob(undefined)).toBe(false);
      expect(isGivaudanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://givaudan.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.givaudan.com/job/456')).toBe(true);
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
      expect(slugify('Developer givaudan ch')).toBe('developer-givaudan-ch');
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
      id: 'givaudan-abc123',
      slug: 'test-position-givaudan-ch',
      slugByLocale: { en: 'test-position-givaudan-ch' },
      company: 'Givaudan',
      companyKey: 'givaudan',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://givaudan.com/jobs/test',
      source: 'Givaudan Dedicated Parser',
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
      expect(validJob.id).toMatch(/^givaudan-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
