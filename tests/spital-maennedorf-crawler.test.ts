import { describe, it, expect } from 'vitest';
import {
  SPITAL_MAENNEDORF_KEY,
  SPITAL_MAENNEDORF_COMPANY_NAME,
  isSpitalMaennedorfJob,
  isTrustedDomain,
} from '../scripts/lib/spital-maennedorf-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spital Männedorf crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_MAENNEDORF_KEY).toBe('spital-maennedorf');
    expect(SPITAL_MAENNEDORF_COMPANY_NAME).toBe('Spital Männedorf');
  });

  // ── isCompanyJob ──
  describe('isSpitalMaennedorfJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalMaennedorfJob({ companyKey: 'spital-maennedorf' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpitalMaennedorfJob({ company: 'Spital Männedorf' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpitalMaennedorfJob({ url: 'https://spitalmaennedorf.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalMaennedorfJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalMaennedorfJob(null)).toBe(false);
      expect(isSpitalMaennedorfJob(undefined)).toBe(false);
      expect(isSpitalMaennedorfJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://spitalmaennedorf.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.spitalmaennedorf.ch/job/456')).toBe(true);
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
      expect(slugify('Developer spital-maennedorf ch')).toBe('developer-spital-maennedorf-ch');
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
      id: 'spital-maennedorf-abc123',
      slug: 'test-position-spital-maennedorf-ch',
      slugByLocale: { de: 'test-position-spital-maennedorf-ch' },
      company: 'Spital Männedorf',
      companyKey: 'spital-maennedorf',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://spitalmaennedorf.ch/jobs/test',
      source: 'Spital Männedorf Dedicated Parser',
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
      expect(validJob.id).toMatch(/^spital-maennedorf-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
