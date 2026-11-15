import { describe, it, expect } from 'vitest';
import {
  CNVO_CH_KEY,
  CNVO_CH_COMPANY_NAME,
  isCnvoChJob,
  isTrustedDomain,
} from '../scripts/lib/cnvo-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CNVO SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CNVO_CH_KEY).toBe('cnvo-ch');
    expect(CNVO_CH_COMPANY_NAME).toBe('CNVO SA');
  });

  // ── isCompanyJob ──
  describe('isCnvoChJob', () => {
    it('matches by companyKey', () => {
      expect(isCnvoChJob({ companyKey: 'cnvo-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCnvoChJob({ company: 'CNVO SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCnvoChJob({ url: 'https://cnvo.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCnvoChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCnvoChJob(null)).toBe(false);
      expect(isCnvoChJob(undefined)).toBe(false);
      expect(isCnvoChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cnvo.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.cnvo.ch/job/456')).toBe(true);
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
      expect(slugify('Developer cnvo-ch ch')).toBe('developer-cnvo-ch-ch');
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
      id: 'cnvo-ch-abc123',
      slug: 'test-position-cnvo-ch-ch',
      slugByLocale: { fr: 'test-position-cnvo-ch-ch' },
      company: 'CNVO SA',
      companyKey: 'cnvo-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://cnvo.ch/jobs/test',
      source: 'CNVO SA Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^cnvo-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
