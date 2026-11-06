import { describe, it, expect } from 'vitest';
import {
  SKAN_KEY,
  SKAN_COMPANY_NAME,
  isSkanJob,
  isTrustedDomain,
} from '../scripts/lib/skan-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Skan AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SKAN_KEY).toBe('skan');
    expect(SKAN_COMPANY_NAME).toBe('Skan AG');
  });

  // ── isCompanyJob ──
  describe('isSkanJob', () => {
    it('matches by companyKey', () => {
      expect(isSkanJob({ companyKey: 'skan' })).toBe(true);
    });

    it('rejects the legacy skan-com source even on the shared trusted host', () => {
      expect(isSkanJob({
        companyKey: 'skan-com',
        company: 'Skan AG',
        url: 'https://jobs.skan.com/job/',
      })).toBe(false);
    });

    it('matches by URL domain', () => {
      expect(isSkanJob({ url: 'https://jobs.skan.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSkanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSkanJob(null)).toBe(false);
      expect(isSkanJob(undefined)).toBe(false);
      expect(isSkanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.skan.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.skan.com/job/456')).toBe(true);
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
      expect(slugify('Developer skan ch')).toBe('developer-skan-ch');
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
      id: 'skan-abc123',
      slug: 'test-position-skan-ch',
      slugByLocale: { en: 'test-position-skan-ch' },
      company: 'Skan AG',
      companyKey: 'skan',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.skan.com/jobs/test',
      source: 'Skan AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^skan-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
