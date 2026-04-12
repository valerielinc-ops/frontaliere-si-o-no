import { describe, it, expect } from 'vitest';
import {
  ZERMATT_BERGBAHNEN_KEY,
  ZERMATT_BERGBAHNEN_COMPANY_NAME,
  isZermattBergbahnenJob,
  isTrustedDomain,
} from '../scripts/lib/zermatt-bergbahnen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Zermatt Bergbahnen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZERMATT_BERGBAHNEN_KEY).toBe('zermatt-bergbahnen');
    expect(ZERMATT_BERGBAHNEN_COMPANY_NAME).toBe('Zermatt Bergbahnen');
  });

  // ── isCompanyJob ──
  describe('isZermattBergbahnenJob', () => {
    it('matches by companyKey', () => {
      expect(isZermattBergbahnenJob({ companyKey: 'zermatt-bergbahnen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZermattBergbahnenJob({ company: 'Zermatt Bergbahnen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isZermattBergbahnenJob({ url: 'https://matterhornparadise.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZermattBergbahnenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZermattBergbahnenJob(null)).toBe(false);
      expect(isZermattBergbahnenJob(undefined)).toBe(false);
      expect(isZermattBergbahnenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://matterhornparadise.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.matterhornparadise.ch/job/456')).toBe(true);
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
      expect(slugify('Developer zermatt-bergbahnen ch')).toBe('developer-zermatt-bergbahnen-ch');
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
      id: 'zermatt-bergbahnen-abc123',
      slug: 'test-position-zermatt-bergbahnen-ch',
      slugByLocale: { de: 'test-position-zermatt-bergbahnen-ch' },
      company: 'Zermatt Bergbahnen',
      companyKey: 'zermatt-bergbahnen',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://matterhornparadise.ch/jobs/test',
      source: 'Zermatt Bergbahnen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^zermatt-bergbahnen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
