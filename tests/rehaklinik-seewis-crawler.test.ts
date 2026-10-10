import { describe, it, expect } from 'vitest';
import {
  REHAKLINIK_SEEWIS_KEY,
  REHAKLINIK_SEEWIS_COMPANY_NAME,
  isRehaklinikSeewisJob,
  isTrustedDomain,
} from '../scripts/lib/rehaklinik-seewis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kurhaus crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(REHAKLINIK_SEEWIS_KEY).toBe('rehaklinik-seewis');
    expect(REHAKLINIK_SEEWIS_COMPANY_NAME).toBe('Kurhaus');
  });

  // ── isCompanyJob ──
  describe('isRehaklinikSeewisJob', () => {
    it('matches by companyKey', () => {
      expect(isRehaklinikSeewisJob({ companyKey: 'rehaklinik-seewis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRehaklinikSeewisJob({ company: 'Kurhaus' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRehaklinikSeewisJob({ url: 'https://vitrea-gesundheit.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRehaklinikSeewisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRehaklinikSeewisJob(null)).toBe(false);
      expect(isRehaklinikSeewisJob(undefined)).toBe(false);
      expect(isRehaklinikSeewisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vitrea-gesundheit.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vitrea-gesundheit.ch/job/456')).toBe(true);
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
      expect(slugify('Developer rehaklinik-seewis ch')).toBe('developer-rehaklinik-seewis-ch');
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
      id: 'rehaklinik-seewis-abc123',
      slug: 'test-position-rehaklinik-seewis-ch',
      slugByLocale: { de: 'test-position-rehaklinik-seewis-ch' },
      company: 'Kurhaus',
      companyKey: 'rehaklinik-seewis',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vitrea-gesundheit.ch/jobs/test',
      source: 'Kurhaus Dedicated Parser',
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
      expect(validJob.id).toMatch(/^rehaklinik-seewis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
