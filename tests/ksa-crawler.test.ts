import { describe, it, expect } from 'vitest';
import {
  KSA_KEY,
  KSA_COMPANY_NAME,
  isKsaJob,
  isTrustedDomain,
} from '../scripts/lib/ksa-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kantonsspital Aarau (KSA) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KSA_KEY).toBe('ksa');
    expect(KSA_COMPANY_NAME).toBe('Kantonsspital Aarau (KSA)');
  });

  // ── isCompanyJob ──
  describe('isKsaJob', () => {
    it('matches by companyKey', () => {
      expect(isKsaJob({ companyKey: 'ksa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKsaJob({ company: 'Kantonsspital Aarau (KSA)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKsaJob({ url: 'https://ksa.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKsaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKsaJob(null)).toBe(false);
      expect(isKsaJob(undefined)).toBe(false);
      expect(isKsaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ksa.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ksa.ch/job/456')).toBe(true);
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
      expect(slugify('Developer ksa ch')).toBe('developer-ksa-ch');
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
      id: 'ksa-abc123',
      slug: 'test-position-ksa-ch',
      slugByLocale: { de: 'test-position-ksa-ch' },
      company: 'Kantonsspital Aarau (KSA)',
      companyKey: 'ksa',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ksa.ch/jobs/test',
      source: 'Kantonsspital Aarau (KSA) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ksa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
