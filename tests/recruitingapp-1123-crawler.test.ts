import { describe, it, expect } from 'vitest';
import {
  RECRUITINGAPP_1123_KEY,
  RECRUITINGAPP_1123_COMPANY_NAME,
  isRecruitingapp1123Job,
  isTrustedDomain,
} from '../scripts/lib/recruitingapp-1123-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('BIG & ARE Stellen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RECRUITINGAPP_1123_KEY).toBe('recruitingapp-1123');
    expect(RECRUITINGAPP_1123_COMPANY_NAME).toBe('BIG & ARE Stellen');
  });

  // ── isCompanyJob ──
  describe('isRecruitingapp1123Job', () => {
    it('matches by companyKey', () => {
      expect(isRecruitingapp1123Job({ companyKey: 'recruitingapp-1123' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRecruitingapp1123Job({ company: 'BIG & ARE Stellen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRecruitingapp1123Job({ url: 'https://recruitingapp-1123.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRecruitingapp1123Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRecruitingapp1123Job(null)).toBe(false);
      expect(isRecruitingapp1123Job(undefined)).toBe(false);
      expect(isRecruitingapp1123Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-1123.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-1123.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer recruitingapp-1123 ch')).toBe('developer-recruitingapp-1123-ch');
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
      id: 'recruitingapp-1123-abc123',
      slug: 'test-position-recruitingapp-1123-ch',
      slugByLocale: { de: 'test-position-recruitingapp-1123-ch' },
      company: 'BIG & ARE Stellen',
      companyKey: 'recruitingapp-1123',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-1123.umantis.com/jobs/test',
      source: 'BIG & ARE Stellen Dedicated Parser',
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
      expect(validJob.id).toMatch(/^recruitingapp-1123-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
