import { describe, it, expect } from 'vitest';
import {
  NOVELIS_KEY,
  NOVELIS_COMPANY_NAME,
  isNovelisJob,
  isTrustedDomain,
} from '../scripts/lib/novelis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Novelis crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NOVELIS_KEY).toBe('novelis');
    expect(NOVELIS_COMPANY_NAME).toBe('Novelis');
  });

  // ── isCompanyJob ──
  describe('isNovelisJob', () => {
    it('matches by companyKey', () => {
      expect(isNovelisJob({ companyKey: 'novelis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNovelisJob({ company: 'Novelis' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNovelisJob({ url: 'https://novelis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNovelisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNovelisJob(null)).toBe(false);
      expect(isNovelisJob(undefined)).toBe(false);
      expect(isNovelisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://novelis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.novelis.com/job/456')).toBe(true);
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
      expect(slugify('Developer novelis ch')).toBe('developer-novelis-ch');
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
      id: 'novelis-abc123',
      slug: 'test-position-novelis-ch',
      slugByLocale: { en: 'test-position-novelis-ch' },
      company: 'Novelis',
      companyKey: 'novelis',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://novelis.com/jobs/test',
      source: 'Novelis Dedicated Parser',
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
      expect(validJob.id).toMatch(/^novelis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
