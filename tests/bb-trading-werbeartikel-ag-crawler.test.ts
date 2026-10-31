import { describe, it, expect } from 'vitest';
import {
  BB_TRADING_WERBEARTIKEL_AG_KEY,
  BB_TRADING_WERBEARTIKEL_AG_COMPANY_NAME,
  isBbTradingWerbeartikelAgJob,
  isTrustedDomain,
} from '../scripts/lib/bb-trading-werbeartikel-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('bb trading werbeartikel ag crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BB_TRADING_WERBEARTIKEL_AG_KEY).toBe('bb-trading-werbeartikel-ag');
    expect(BB_TRADING_WERBEARTIKEL_AG_COMPANY_NAME).toBe('bb trading werbeartikel ag');
  });

  // ── isCompanyJob ──
  describe('isBbTradingWerbeartikelAgJob', () => {
    it('matches by companyKey', () => {
      expect(isBbTradingWerbeartikelAgJob({ companyKey: 'bb-trading-werbeartikel-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBbTradingWerbeartikelAgJob({ company: 'bb trading werbeartikel ag' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBbTradingWerbeartikelAgJob({ url: 'https://link.ostendis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBbTradingWerbeartikelAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBbTradingWerbeartikelAgJob(null)).toBe(false);
      expect(isBbTradingWerbeartikelAgJob(undefined)).toBe(false);
      expect(isBbTradingWerbeartikelAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://link.ostendis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.link.ostendis.com/job/456')).toBe(true);
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
      expect(slugify('Developer bb-trading-werbeartikel-ag ch')).toBe('developer-bb-trading-werbeartikel-ag-ch');
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
      id: 'bb-trading-werbeartikel-ag-abc123',
      slug: 'test-position-bb-trading-werbeartikel-ag-ch',
      slugByLocale: { de: 'test-position-bb-trading-werbeartikel-ag-ch' },
      company: 'bb trading werbeartikel ag',
      companyKey: 'bb-trading-werbeartikel-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://link.ostendis.com/jobs/test',
      source: 'bb trading werbeartikel ag Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bb-trading-werbeartikel-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
