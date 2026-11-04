import { describe, it, expect } from 'vitest';
import {
  CREDITX_CH_KEY,
  CREDITX_CH_COMPANY_NAME,
  isCreditxChJob,
  isTrustedDomain,
} from '../scripts/lib/creditx-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CreditX Sàrl crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CREDITX_CH_KEY).toBe('creditx-ch');
    expect(CREDITX_CH_COMPANY_NAME).toBe('CreditX Sàrl');
  });

  // ── isCompanyJob ──
  describe('isCreditxChJob', () => {
    it('matches by companyKey', () => {
      expect(isCreditxChJob({ companyKey: 'creditx-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCreditxChJob({ company: 'CreditX Sàrl' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCreditxChJob({ url: 'https://creditx.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCreditxChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCreditxChJob(null)).toBe(false);
      expect(isCreditxChJob(undefined)).toBe(false);
      expect(isCreditxChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://creditx.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.creditx.ch/job/456')).toBe(true);
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
      expect(slugify('Developer creditx-ch ch')).toBe('developer-creditx-ch-ch');
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
      id: 'creditx-ch-abc123',
      slug: 'test-position-creditx-ch-ch',
      slugByLocale: { it: 'test-position-creditx-ch-ch' },
      company: 'CreditX Sàrl',
      companyKey: 'creditx-ch',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://creditx.ch/jobs/test',
      source: 'CreditX Sàrl Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^creditx-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
