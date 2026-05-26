import { describe, it, expect } from 'vitest';
import {
  SEE_SPITAL_KEY,
  SEE_SPITAL_COMPANY_NAME,
  isSeeSpitalJob,
  isTrustedDomain,
} from '../scripts/lib/see-spital-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('See-Spital crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SEE_SPITAL_KEY).toBe('see-spital');
    expect(SEE_SPITAL_COMPANY_NAME).toBe('See-Spital');
  });

  // ── isCompanyJob ──
  describe('isSeeSpitalJob', () => {
    it('matches by companyKey', () => {
      expect(isSeeSpitalJob({ companyKey: 'see-spital' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSeeSpitalJob({ company: 'See-Spital' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSeeSpitalJob({ url: 'https://see-spital.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSeeSpitalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSeeSpitalJob(null)).toBe(false);
      expect(isSeeSpitalJob(undefined)).toBe(false);
      expect(isSeeSpitalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://see-spital.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.see-spital.ch/job/456')).toBe(true);
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
      expect(slugify('Developer see-spital ch')).toBe('developer-see-spital-ch');
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
      id: 'see-spital-abc123',
      slug: 'test-position-see-spital-ch',
      slugByLocale: { de: 'test-position-see-spital-ch' },
      company: 'See-Spital',
      companyKey: 'see-spital',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://see-spital.ch/jobs/test',
      source: 'See-Spital Dedicated Parser',
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
      expect(validJob.id).toMatch(/^see-spital-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
