import { describe, it, expect } from 'vitest';
import {
  GEORG_FISCHER_KEY,
  GEORG_FISCHER_COMPANY_NAME,
  isGeorgFischerJob,
  isTrustedDomain,
} from '../scripts/lib/georg-fischer-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Georg Fischer crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GEORG_FISCHER_KEY).toBe('georg-fischer');
    expect(GEORG_FISCHER_COMPANY_NAME).toBe('Georg Fischer');
  });

  // ── isCompanyJob ──
  describe('isGeorgFischerJob', () => {
    it('matches by companyKey', () => {
      expect(isGeorgFischerJob({ companyKey: 'georg-fischer' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGeorgFischerJob({ company: 'Georg Fischer' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGeorgFischerJob({ url: 'https://georgfischer.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGeorgFischerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGeorgFischerJob(null)).toBe(false);
      expect(isGeorgFischerJob(undefined)).toBe(false);
      expect(isGeorgFischerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://georgfischer.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.georgfischer.com/job/456')).toBe(true);
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
      expect(slugify('Developer georg-fischer ch')).toBe('developer-georg-fischer-ch');
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
      id: 'georg-fischer-abc123',
      slug: 'test-position-georg-fischer-ch',
      slugByLocale: { en: 'test-position-georg-fischer-ch' },
      company: 'Georg Fischer',
      companyKey: 'georg-fischer',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://georgfischer.com/jobs/test',
      source: 'Georg Fischer Dedicated Parser',
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
      expect(validJob.id).toMatch(/^georg-fischer-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
