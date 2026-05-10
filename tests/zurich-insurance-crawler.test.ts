import { describe, it, expect } from 'vitest';
import {
  ZURICH_INSURANCE_KEY,
  ZURICH_INSURANCE_COMPANY_NAME,
  isZurichInsuranceJob,
  isTrustedDomain,
} from '../scripts/lib/zurich-insurance-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Zurich Insurance Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZURICH_INSURANCE_KEY).toBe('zurich-insurance');
    expect(ZURICH_INSURANCE_COMPANY_NAME).toBe('Zurich Insurance Group');
  });

  // ── isCompanyJob ──
  describe('isZurichInsuranceJob', () => {
    it('matches by companyKey', () => {
      expect(isZurichInsuranceJob({ companyKey: 'zurich-insurance' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZurichInsuranceJob({ company: 'Zurich Insurance Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isZurichInsuranceJob({ url: 'https://zurichinsurance.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZurichInsuranceJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZurichInsuranceJob(null)).toBe(false);
      expect(isZurichInsuranceJob(undefined)).toBe(false);
      expect(isZurichInsuranceJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://zurichinsurance.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.zurichinsurance.ch/job/456')).toBe(true);
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
      expect(slugify('Developer zurich-insurance ch')).toBe('developer-zurich-insurance-ch');
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
      id: 'zurich-insurance-abc123',
      slug: 'test-position-zurich-insurance-ch',
      slugByLocale: { it: 'test-position-zurich-insurance-ch' },
      company: 'Zurich Insurance Group',
      companyKey: 'zurich-insurance',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://zurichinsurance.ch/jobs/test',
      source: 'Zurich Insurance Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^zurich-insurance-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
