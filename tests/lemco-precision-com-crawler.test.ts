import { describe, it, expect } from 'vitest';
import {
  LEMCO_PRECISION_COM_KEY,
  LEMCO_PRECISION_COM_COMPANY_NAME,
  isLemcoPrecisionComJob,
  isTrustedDomain,
} from '../scripts/lib/lemco-precision-com-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Lemco Précision SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LEMCO_PRECISION_COM_KEY).toBe('lemco-precision-com');
    expect(LEMCO_PRECISION_COM_COMPANY_NAME).toBe('Lemco Précision SA');
  });

  // ── isCompanyJob ──
  describe('isLemcoPrecisionComJob', () => {
    it('matches by companyKey', () => {
      expect(isLemcoPrecisionComJob({ companyKey: 'lemco-precision-com' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLemcoPrecisionComJob({ company: 'Lemco Précision SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLemcoPrecisionComJob({ url: 'https://lemco-precision.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLemcoPrecisionComJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLemcoPrecisionComJob(null)).toBe(false);
      expect(isLemcoPrecisionComJob(undefined)).toBe(false);
      expect(isLemcoPrecisionComJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://lemco-precision.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.lemco-precision.com/job/456')).toBe(true);
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
      expect(slugify('Developer lemco-precision-com ch')).toBe('developer-lemco-precision-com-ch');
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
      id: 'lemco-precision-com-abc123',
      slug: 'test-position-lemco-precision-com-ch',
      slugByLocale: { en: 'test-position-lemco-precision-com-ch' },
      company: 'Lemco Précision SA',
      companyKey: 'lemco-precision-com',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://lemco-precision.com/jobs/test',
      source: 'Lemco Précision SA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^lemco-precision-com-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
