import { describe, it, expect } from 'vitest';
import {
  BANKSLM_KEY,
  BANKSLM_COMPANY_NAME,
  isBankslmJob,
  isTrustedDomain,
} from '../scripts/lib/bankslm-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bank SLM AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BANKSLM_KEY).toBe('bankslm');
    expect(BANKSLM_COMPANY_NAME).toBe('Bank SLM AG');
  });

  // ── isCompanyJob ──
  describe('isBankslmJob', () => {
    it('matches by companyKey', () => {
      expect(isBankslmJob({ companyKey: 'bankslm' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBankslmJob({ company: 'Bank SLM AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBankslmJob({ url: 'https://karriere.bankslm.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBankslmJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBankslmJob(null)).toBe(false);
      expect(isBankslmJob(undefined)).toBe(false);
      expect(isBankslmJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://karriere.bankslm.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.karriere.bankslm.ch/job/456')).toBe(true);
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
      expect(slugify('Developer bankslm ch')).toBe('developer-bankslm-ch');
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
      id: 'bankslm-abc123',
      slug: 'test-position-bankslm-ch',
      slugByLocale: { de: 'test-position-bankslm-ch' },
      company: 'Bank SLM AG',
      companyKey: 'bankslm',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://karriere.bankslm.ch/jobs/test',
      source: 'Bank SLM AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bankslm-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
