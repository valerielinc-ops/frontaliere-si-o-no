import { describe, it, expect } from 'vitest';
import {
  C_AND_A_SCHWEIZ_KEY,
  C_AND_A_SCHWEIZ_COMPANY_NAME,
  isCAndASchweizJob,
  isTrustedDomain,
} from '../scripts/lib/c-and-a-schweiz-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('C&A Schweiz crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(C_AND_A_SCHWEIZ_KEY).toBe('c-and-a-schweiz');
    expect(C_AND_A_SCHWEIZ_COMPANY_NAME).toBe('C&A Schweiz');
  });

  // ── isCompanyJob ──
  describe('isCAndASchweizJob', () => {
    it('matches by companyKey', () => {
      expect(isCAndASchweizJob({ companyKey: 'c-and-a-schweiz' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCAndASchweizJob({ company: 'C&A Schweiz' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCAndASchweizJob({ url: 'https://c-and-a.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCAndASchweizJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCAndASchweizJob(null)).toBe(false);
      expect(isCAndASchweizJob(undefined)).toBe(false);
      expect(isCAndASchweizJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://c-and-a.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.c-and-a.com/job/456')).toBe(true);
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
      expect(slugify('Developer c-and-a-schweiz ch')).toBe('developer-c-and-a-schweiz-ch');
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
      id: 'c-and-a-schweiz-abc123',
      slug: 'test-position-c-and-a-schweiz-ch',
      slugByLocale: { de: 'test-position-c-and-a-schweiz-ch' },
      company: 'C&A Schweiz',
      companyKey: 'c-and-a-schweiz',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://c-and-a.com/jobs/test',
      source: 'C&A Schweiz Dedicated Parser',
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
      expect(validJob.id).toMatch(/^c-and-a-schweiz-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
