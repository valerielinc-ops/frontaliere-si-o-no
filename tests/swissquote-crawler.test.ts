import { describe, it, expect } from 'vitest';
import {
  SWISSQUOTE_KEY,
  SWISSQUOTE_COMPANY_NAME,
  isSwissquoteJob,
  isTrustedDomain,
} from '../scripts/lib/swissquote-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Swissquote crawler parser', () => {
  // ── Constants ──
  it('exports valid company key name', () => {
    expect(SWISSQUOTE_KEY).toBe('swissquote');
    expect(SWISSQUOTE_COMPANY_NAME).toBe('Swissquote');
  });

  // ── isCompanyJob ──
  describe('isSwissquoteJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissquoteJob({ companyKey: 'swissquote' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissquoteJob({ company: 'Swissquote' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissquoteJob({ url: 'https://www.swissquote.com/careers/123' })).toBe(true);
    });

    it('matches by SmartRecruiters URL', () => {
      expect(isSwissquoteJob({ url: 'https://jobs.smartrecruiters.com/swissquote/456' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissquoteJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissquoteJob(null)).toBe(false);
      expect(isSwissquoteJob(undefined)).toBe(false);
      expect(isSwissquoteJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.swissquote.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swissquote.com/job/456')).toBe(true);
    });

    it('trusts SmartRecruiters tenant URLs', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/swissquote/789')).toBe(true);
      expect(isTrustedDomain('https://careers.smartrecruiters.com/swissquote')).toBe(true);
      expect(isTrustedDomain('https://api.smartrecruiters.com/v1/companies/swissquote/postings/789')).toBe(true);
    });

    it('rejects other SmartRecruiters tenants', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/otherco/789')).toBe(false);
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
      expect(slugify('Developer swissquote gland')).toBe('developer-swissquote-gland');
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
      id: 'swissquote-abc123',
      slug: 'test-position-swissquote-gland',
      slugByLocale: { en: 'test-position-swissquote-gland' },
      company: 'Swissquote',
      companyKey: 'swissquote',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Gland',
      canton: 'VD',
      postalCode: '1196',
      streetAddress: 'Chemin de la Crétaux 33',
      url: 'https://jobs.smartrecruiters.com/swissquote/test',
      source: 'Swissquote Dedicated Parser (SmartRecruiters API)',
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
      expect(validJob.id).toMatch(/^swissquote-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('carries structured-data location fields for the VD (Gland) HQ', () => {
      expect(validJob.canton).toBe('VD');
      expect(validJob.postalCode).toBe('1196');
      expect(validJob.streetAddress).toBeTruthy();
    });
  });
});
