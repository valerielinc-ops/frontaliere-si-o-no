import { describe, it, expect } from 'vitest';
import {
  UBS_KEY,
  UBS_COMPANY_NAME,
  isUbsJob,
  isTrustedDomain,
} from '../scripts/lib/ubs-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('UBS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UBS_KEY).toBe('ubs');
    expect(UBS_COMPANY_NAME).toBe('UBS');
  });

  // ── isCompanyJob ──
  describe('isUbsJob', () => {
    it('matches by companyKey', () => {
      expect(isUbsJob({ companyKey: 'ubs' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUbsJob({ company: 'UBS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUbsJob({ url: 'https://ubs.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUbsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUbsJob(null)).toBe(false);
      expect(isUbsJob(undefined)).toBe(false);
      expect(isUbsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ubs.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ubs.com/job/456')).toBe(true);
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
      expect(slugify('Developer ubs ch')).toBe('developer-ubs-ch');
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
      id: 'ubs-abc123',
      slug: 'test-position-ubs-ch',
      slugByLocale: { en: 'test-position-ubs-ch' },
      company: 'UBS',
      companyKey: 'ubs',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ubs.com/jobs/test',
      source: 'UBS Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ubs-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
