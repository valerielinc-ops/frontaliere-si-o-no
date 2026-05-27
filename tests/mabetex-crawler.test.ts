import { describe, it, expect } from 'vitest';
import {
  MABETEX_KEY,
  MABETEX_COMPANY_NAME,
  isMabetexJob,
  isTrustedDomain,
} from '../scripts/lib/mabetex-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Mabetex Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MABETEX_KEY).toBe('mabetex');
    expect(MABETEX_COMPANY_NAME).toBe('Mabetex Group');
  });

  // ── isCompanyJob ──
  describe('isMabetexJob', () => {
    it('matches by companyKey', () => {
      expect(isMabetexJob({ companyKey: 'mabetex' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMabetexJob({ company: 'Mabetex Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMabetexJob({ url: 'https://mabetex.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMabetexJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMabetexJob(null)).toBe(false);
      expect(isMabetexJob(undefined)).toBe(false);
      expect(isMabetexJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mabetex.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mabetex.com/job/456')).toBe(true);
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
      expect(slugify('Developer mabetex ch')).toBe('developer-mabetex-ch');
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
      id: 'mabetex-abc123',
      slug: 'test-position-mabetex-ch',
      slugByLocale: { en: 'test-position-mabetex-ch' },
      company: 'Mabetex Group',
      companyKey: 'mabetex',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mabetex.com/jobs/test',
      source: 'Mabetex Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^mabetex-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
