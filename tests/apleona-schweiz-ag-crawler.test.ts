import { describe, it, expect } from 'vitest';
import {
  APLEONA_SCHWEIZ_AG_KEY,
  APLEONA_SCHWEIZ_AG_COMPANY_NAME,
  isApleonaSchweizAgJob,
  isTrustedDomain,
} from '../scripts/lib/apleona-schweiz-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Apleona Schweiz AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APLEONA_SCHWEIZ_AG_KEY).toBe('apleona-schweiz-ag');
    expect(APLEONA_SCHWEIZ_AG_COMPANY_NAME).toBe('Apleona Schweiz AG');
  });

  // ── isCompanyJob ──
  describe('isApleonaSchweizAgJob', () => {
    it('matches by companyKey', () => {
      expect(isApleonaSchweizAgJob({ companyKey: 'apleona-schweiz-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isApleonaSchweizAgJob({ company: 'Apleona Schweiz AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isApleonaSchweizAgJob({ url: 'https://recruitingapp-2765.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isApleonaSchweizAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isApleonaSchweizAgJob(null)).toBe(false);
      expect(isApleonaSchweizAgJob(undefined)).toBe(false);
      expect(isApleonaSchweizAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2765.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2765.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer apleona-schweiz-ag ch')).toBe('developer-apleona-schweiz-ag-ch');
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
      id: 'apleona-schweiz-ag-abc123',
      slug: 'test-position-apleona-schweiz-ag-ch',
      slugByLocale: { de: 'test-position-apleona-schweiz-ag-ch' },
      company: 'Apleona Schweiz AG',
      companyKey: 'apleona-schweiz-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2765.umantis.com/jobs/test',
      source: 'Apleona Schweiz AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apleona-schweiz-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
