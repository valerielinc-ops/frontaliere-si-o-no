import { describe, it, expect } from 'vitest';
import {
  APG_SGA_KEY,
  APG_SGA_COMPANY_NAME,
  isApgSgaJob,
  isTrustedDomain,
} from '../scripts/lib/apg-sga-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('APG|SGA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APG_SGA_KEY).toBe('apg-sga');
    expect(APG_SGA_COMPANY_NAME).toBe('APG|SGA');
  });

  // ── isCompanyJob ──
  describe('isApgSgaJob', () => {
    it('matches by companyKey', () => {
      expect(isApgSgaJob({ companyKey: 'apg-sga' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isApgSgaJob({ company: 'APG|SGA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isApgSgaJob({ url: 'https://apgsga.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isApgSgaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isApgSgaJob(null)).toBe(false);
      expect(isApgSgaJob(undefined)).toBe(false);
      expect(isApgSgaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://apgsga.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.apgsga.ch/job/456')).toBe(true);
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
      expect(slugify('Developer apg-sga ch')).toBe('developer-apg-sga-ch');
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
      id: 'apg-sga-abc123',
      slug: 'test-position-apg-sga-ch',
      slugByLocale: { de: 'test-position-apg-sga-ch' },
      company: 'APG|SGA',
      companyKey: 'apg-sga',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://apgsga.ch/jobs/test',
      source: 'APG|SGA Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apg-sga-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
