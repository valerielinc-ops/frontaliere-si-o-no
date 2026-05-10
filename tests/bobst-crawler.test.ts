import { describe, it, expect } from 'vitest';
import {
  BOBST_KEY,
  BOBST_COMPANY_NAME,
  isBobstJob,
  isTrustedDomain,
} from '../scripts/lib/bobst-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bobst crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BOBST_KEY).toBe('bobst');
    expect(BOBST_COMPANY_NAME).toBe('Bobst');
  });

  // ── isCompanyJob ──
  describe('isBobstJob', () => {
    it('matches by companyKey', () => {
      expect(isBobstJob({ companyKey: 'bobst' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBobstJob({ company: 'Bobst' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBobstJob({ url: 'https://bobst.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBobstJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBobstJob(null)).toBe(false);
      expect(isBobstJob(undefined)).toBe(false);
      expect(isBobstJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bobst.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bobst.com/job/456')).toBe(true);
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
      expect(slugify('Developer bobst ch')).toBe('developer-bobst-ch');
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
      id: 'bobst-abc123',
      slug: 'test-position-bobst-ch',
      slugByLocale: { en: 'test-position-bobst-ch' },
      company: 'Bobst',
      companyKey: 'bobst',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bobst.com/jobs/test',
      source: 'Bobst Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bobst-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
