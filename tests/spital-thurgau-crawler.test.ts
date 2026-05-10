import { describe, it, expect } from 'vitest';
import {
  SPITAL_THURGAU_KEY,
  SPITAL_THURGAU_COMPANY_NAME,
  isSpitalThurgauJob,
  isTrustedDomain,
} from '../scripts/lib/spital-thurgau-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spital Thurgau (STGAG) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_THURGAU_KEY).toBe('spital-thurgau');
    expect(SPITAL_THURGAU_COMPANY_NAME).toBe('Spital Thurgau (STGAG)');
  });

  // ── isCompanyJob ──
  describe('isSpitalThurgauJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalThurgauJob({ companyKey: 'spital-thurgau' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpitalThurgauJob({ company: 'Spital Thurgau (STGAG)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpitalThurgauJob({ url: 'https://stgag.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalThurgauJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalThurgauJob(null)).toBe(false);
      expect(isSpitalThurgauJob(undefined)).toBe(false);
      expect(isSpitalThurgauJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stgag.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stgag.ch/job/456')).toBe(true);
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
      expect(slugify('Developer spital-thurgau ch')).toBe('developer-spital-thurgau-ch');
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
      id: 'spital-thurgau-abc123',
      slug: 'test-position-spital-thurgau-ch',
      slugByLocale: { de: 'test-position-spital-thurgau-ch' },
      company: 'Spital Thurgau (STGAG)',
      companyKey: 'spital-thurgau',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stgag.ch/jobs/test',
      source: 'Spital Thurgau (STGAG) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^spital-thurgau-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
