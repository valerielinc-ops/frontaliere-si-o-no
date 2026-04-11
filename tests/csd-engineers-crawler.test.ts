import { describe, it, expect } from 'vitest';
import {
  CSD_ENGINEERS_KEY,
  CSD_ENGINEERS_COMPANY_NAME,
  isCsdEngineersJob,
  isTrustedDomain,
} from '../scripts/lib/csd-engineers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CSD ENGINEERS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSD_ENGINEERS_KEY).toBe('csd-engineers');
    expect(CSD_ENGINEERS_COMPANY_NAME).toBe('CSD ENGINEERS');
  });

  // ── isCompanyJob ──
  describe('isCsdEngineersJob', () => {
    it('matches by companyKey', () => {
      expect(isCsdEngineersJob({ companyKey: 'csd-engineers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCsdEngineersJob({ company: 'CSD ENGINEERS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCsdEngineersJob({ url: 'https://csd.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCsdEngineersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCsdEngineersJob(null)).toBe(false);
      expect(isCsdEngineersJob(undefined)).toBe(false);
      expect(isCsdEngineersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://csd.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.csd.ch/job/456')).toBe(true);
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
      expect(slugify('Developer csd-engineers ch')).toBe('developer-csd-engineers-ch');
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
      id: 'csd-engineers-abc123',
      slug: 'test-position-csd-engineers-ch',
      slugByLocale: { fr: 'test-position-csd-engineers-ch' },
      company: 'CSD ENGINEERS',
      companyKey: 'csd-engineers',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://csd.ch/jobs/test',
      source: 'CSD ENGINEERS Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^csd-engineers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
