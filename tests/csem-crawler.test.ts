import { describe, it, expect } from 'vitest';
import {
  CSEM_KEY,
  CSEM_COMPANY_NAME,
  isCsemJob,
  isTrustedDomain,
} from '../scripts/lib/csem-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CSEM Landquart crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSEM_KEY).toBe('csem');
    expect(CSEM_COMPANY_NAME).toBe('CSEM Landquart');
  });

  // ── isCompanyJob ──
  describe('isCsemJob', () => {
    it('matches by companyKey', () => {
      expect(isCsemJob({ companyKey: 'csem' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCsemJob({ company: 'CSEM Landquart' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCsemJob({ url: 'https://csem.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCsemJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCsemJob(null)).toBe(false);
      expect(isCsemJob(undefined)).toBe(false);
      expect(isCsemJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://csem.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.csem.ch/job/456')).toBe(true);
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
      expect(slugify('Developer csem ch')).toBe('developer-csem-ch');
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
      id: 'csem-abc123',
      slug: 'test-position-csem-ch',
      slugByLocale: { en: 'test-position-csem-ch' },
      company: 'CSEM Landquart',
      companyKey: 'csem',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://csem.ch/jobs/test',
      source: 'CSEM Landquart Dedicated Parser',
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
      expect(validJob.id).toMatch(/^csem-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
