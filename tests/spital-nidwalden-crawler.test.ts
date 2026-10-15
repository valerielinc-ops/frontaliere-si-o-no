import { describe, it, expect } from 'vitest';
import {
  SPITAL_NIDWALDEN_KEY,
  SPITAL_NIDWALDEN_COMPANY_NAME,
  isSpitalNidwaldenJob,
  isTrustedDomain,
} from '../scripts/lib/spital-nidwalden-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spital Nidwalden crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_NIDWALDEN_KEY).toBe('spital-nidwalden');
    expect(SPITAL_NIDWALDEN_COMPANY_NAME).toBe('Spital Nidwalden');
  });

  // ── isCompanyJob ──
  describe('isSpitalNidwaldenJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalNidwaldenJob({ companyKey: 'spital-nidwalden' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSpitalNidwaldenJob({ company: 'Spital Nidwalden' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpitalNidwaldenJob({ url: 'https://spital-nidwalden.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalNidwaldenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalNidwaldenJob(null)).toBe(false);
      expect(isSpitalNidwaldenJob(undefined)).toBe(false);
      expect(isSpitalNidwaldenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://spital-nidwalden.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.spital-nidwalden.ch/job/456')).toBe(true);
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
      expect(slugify('Developer spital-nidwalden ch')).toBe('developer-spital-nidwalden-ch');
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
      id: 'spital-nidwalden-abc123',
      slug: 'test-position-spital-nidwalden-ch',
      slugByLocale: { de: 'test-position-spital-nidwalden-ch' },
      company: 'Spital Nidwalden',
      companyKey: 'spital-nidwalden',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://spital-nidwalden.ch/jobs/test',
      source: 'Spital Nidwalden Dedicated Parser',
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
      expect(validJob.id).toMatch(/^spital-nidwalden-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
