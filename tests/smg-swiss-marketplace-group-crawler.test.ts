import { describe, it, expect } from 'vitest';
import {
  SMG_SWISS_MARKETPLACE_GROUP_KEY,
  SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME,
  isSmgSwissMarketplaceGroupJob,
  isTrustedDomain,
} from '../scripts/lib/smg-swiss-marketplace-group-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SMG Swiss Marketplace Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SMG_SWISS_MARKETPLACE_GROUP_KEY).toBe('smg-swiss-marketplace-group');
    expect(SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME).toBe('SMG Swiss Marketplace Group');
  });

  it('does not collide with the unrelated tsmg crawler slug', () => {
    expect(SMG_SWISS_MARKETPLACE_GROUP_KEY).not.toBe('tsmg');
    expect(SMG_SWISS_MARKETPLACE_GROUP_KEY.startsWith('tsmg')).toBe(false);
  });

  // ── isCompanyJob ──
  describe('isSmgSwissMarketplaceGroupJob', () => {
    it('matches by companyKey', () => {
      expect(isSmgSwissMarketplaceGroupJob({ companyKey: 'smg-swiss-marketplace-group' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSmgSwissMarketplaceGroupJob({ company: 'SMG Swiss Marketplace Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSmgSwissMarketplaceGroupJob({ url: 'https://swissmarketplace.group/career/job/123' })).toBe(true);
    });

    it('matches by SmartRecruiters tenant URL', () => {
      expect(
        isSmgSwissMarketplaceGroupJob({ url: 'https://jobs.smartrecruiters.com/SMGSwissMarketplaceGroup/744000130181060' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSmgSwissMarketplaceGroupJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects the unrelated tsmg crawler jobs', () => {
      expect(isSmgSwissMarketplaceGroupJob({ companyKey: 'tsmg', company: 'TSMG', url: 'https://jobs.lever.co/tsmg/123' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSmgSwissMarketplaceGroupJob(null)).toBe(false);
      expect(isSmgSwissMarketplaceGroupJob(undefined)).toBe(false);
      expect(isSmgSwissMarketplaceGroupJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swissmarketplace.group/career/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swissmarketplace.group/job/456')).toBe(true);
    });

    it('trusts the SmartRecruiters tenant host', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/SMGSwissMarketplaceGroup/744000130181060')).toBe(true);
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
      expect(slugify('Developer smg-swiss-marketplace-group ch')).toBe('developer-smg-swiss-marketplace-group-ch');
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
      id: 'smg-swiss-marketplace-group-abc123',
      slug: 'test-position-smg-swiss-marketplace-group-ch',
      slugByLocale: { en: 'test-position-smg-swiss-marketplace-group-ch' },
      company: 'SMG Swiss Marketplace Group',
      companyKey: 'smg-swiss-marketplace-group',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://swissmarketplace.group/career/jobs/test',
      source: 'SMG Swiss Marketplace Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^smg-swiss-marketplace-group-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
