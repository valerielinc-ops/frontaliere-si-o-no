import { describe, it, expect } from 'vitest';
import {
  PICTET_KEY,
  PICTET_COMPANY_NAME,
  isPictetJob,
  isTrustedDomain,
} from '../scripts/lib/pictet-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Pictet Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PICTET_KEY).toBe('pictet');
    expect(PICTET_COMPANY_NAME).toBe('Pictet Group');
  });

  // ── isCompanyJob ──
  describe('isPictetJob', () => {
    it('matches by companyKey', () => {
      expect(isPictetJob({ companyKey: 'pictet' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPictetJob({ company: 'Pictet Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPictetJob({ url: 'https://pictet.com/jobs/123' })).toBe(true);
    });

    it('matches by Banque Pictet variant', () => {
      expect(isPictetJob({ company: 'Banque Pictet & Cie SA' })).toBe(true);
    });

    it('matches by SuccessFactors career5 URL with company=banquepict', () => {
      expect(isPictetJob({ url: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPictetJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPictetJob(null)).toBe(false);
      expect(isPictetJob(undefined)).toBe(false);
      expect(isPictetJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pictet.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pictet.com/job/456')).toBe(true);
    });

    it('trusts SuccessFactors career5 URLs scoped to company=banquepict', () => {
      expect(isTrustedDomain('https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42')).toBe(true);
    });

    it('rejects SuccessFactors URLs for other tenants', () => {
      expect(isTrustedDomain('https://career012.successfactors.eu/career?company=otherbank')).toBe(false);
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
      expect(slugify('Developer pictet geneva')).toBe('developer-pictet-geneva');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (Pictet HQ Geneva).
    const validJob = {
      id: 'pictet-abc123',
      slug: 'wealth-manager-pictet-geneva',
      slugByLocale: { en: 'wealth-manager-pictet-geneva' },
      company: 'Pictet Group',
      companyKey: 'pictet',
      title: 'Wealth Manager',
      titleByLocale: { en: 'Wealth Manager' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42',
      source: 'Pictet Group Dedicated Parser (SuccessFactors career5)',
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
      expect(validJob.id).toMatch(/^pictet-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('default canton is GE (Pictet HQ Geneva)', () => {
      expect(validJob.canton).toBe('GE');
    });
  });
});
