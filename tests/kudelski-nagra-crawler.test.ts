import { describe, it, expect } from 'vitest';
import {
  KUDELSKI_NAGRA_KEY,
  KUDELSKI_NAGRA_COMPANY_NAME,
  isKudelskiNagraJob,
  isTrustedDomain,
} from '../scripts/lib/kudelski-nagra-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kudelski NAGRA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KUDELSKI_NAGRA_KEY).toBe('kudelski-nagra');
    expect(KUDELSKI_NAGRA_COMPANY_NAME).toBe('Kudelski NAGRA');
  });

  // ── isCompanyJob ──
  describe('isKudelskiNagraJob', () => {
    it('matches by companyKey', () => {
      expect(isKudelskiNagraJob({ companyKey: 'kudelski-nagra' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKudelskiNagraJob({ company: 'Kudelski NAGRA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKudelskiNagraJob({ url: 'https://nagra.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKudelskiNagraJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKudelskiNagraJob(null)).toBe(false);
      expect(isKudelskiNagraJob(undefined)).toBe(false);
      expect(isKudelskiNagraJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nagra.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nagra.com/job/456')).toBe(true);
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
      expect(slugify('Developer kudelski-nagra ch')).toBe('developer-kudelski-nagra-ch');
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
      id: 'kudelski-nagra-abc123',
      slug: 'test-position-kudelski-nagra-ch',
      slugByLocale: { en: 'test-position-kudelski-nagra-ch' },
      company: 'Kudelski NAGRA',
      companyKey: 'kudelski-nagra',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nagra.com/jobs/test',
      source: 'Kudelski NAGRA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kudelski-nagra-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
