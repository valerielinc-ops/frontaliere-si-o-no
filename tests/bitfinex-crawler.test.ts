import { describe, it, expect } from 'vitest';
import {
  BITFINEX_KEY,
  BITFINEX_COMPANY_NAME,
  isBitfinexJob,
  isTrustedDomain,
} from '../scripts/lib/bitfinex-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bitfinex crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BITFINEX_KEY).toBe('bitfinex');
    expect(BITFINEX_COMPANY_NAME).toBe('Bitfinex');
  });

  // ── isCompanyJob ──
  describe('isBitfinexJob', () => {
    it('matches by companyKey', () => {
      expect(isBitfinexJob({ companyKey: 'bitfinex' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBitfinexJob({ company: 'Bitfinex' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBitfinexJob({ url: 'https://bitfinex.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBitfinexJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBitfinexJob(null)).toBe(false);
      expect(isBitfinexJob(undefined)).toBe(false);
      expect(isBitfinexJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bitfinex.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bitfinex.com/job/456')).toBe(true);
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
      expect(slugify('Developer bitfinex ch')).toBe('developer-bitfinex-ch');
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
      id: 'bitfinex-abc123',
      slug: 'test-position-bitfinex-ch',
      slugByLocale: { en: 'test-position-bitfinex-ch' },
      company: 'Bitfinex',
      companyKey: 'bitfinex',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bitfinex.com/jobs/test',
      source: 'Bitfinex Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bitfinex-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
