import { describe, it, expect } from 'vitest';
import {
  KONE_KEY,
  KONE_COMPANY_NAME,
  isKoneJob,
  isTrustedDomain,
} from '../scripts/lib/kone-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('KONE crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KONE_KEY).toBe('kone');
    expect(KONE_COMPANY_NAME).toBe('KONE');
  });

  // ── isCompanyJob ──
  describe('isKoneJob', () => {
    it('matches by companyKey', () => {
      expect(isKoneJob({ companyKey: 'kone' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKoneJob({ company: 'KONE' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKoneJob({ url: 'https://kone.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKoneJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKoneJob(null)).toBe(false);
      expect(isKoneJob(undefined)).toBe(false);
      expect(isKoneJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kone.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.kone.com/job/456')).toBe(true);
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
      expect(slugify('Developer kone ch')).toBe('developer-kone-ch');
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
      id: 'kone-abc123',
      slug: 'test-position-kone-ch',
      slugByLocale: { en: 'test-position-kone-ch' },
      company: 'KONE',
      companyKey: 'kone',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://kone.com/jobs/test',
      source: 'KONE Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kone-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
