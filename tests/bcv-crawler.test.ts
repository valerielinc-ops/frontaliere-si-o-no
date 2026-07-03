import { describe, it, expect } from 'vitest';
import {
  BCV_KEY,
  BCV_COMPANY_NAME,
  isBcvJob,
  isTrustedDomain,
} from '../scripts/lib/bcv-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Banque Cantonale Vaudoise crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BCV_KEY).toBe('bcv');
    expect(BCV_COMPANY_NAME).toBe('Banque Cantonale Vaudoise');
  });

  // ── isCompanyJob ──
  describe('isBcvJob', () => {
    it('matches by companyKey', () => {
      expect(isBcvJob({ companyKey: 'bcv' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBcvJob({ company: 'Banque Cantonale Vaudoise' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBcvJob({ url: 'https://jobs.bcv.ch/job/Lausanne-Analyst/123456/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBcvJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBcvJob(null)).toBe(false);
      expect(isBcvJob(undefined)).toBe(false);
      expect(isBcvJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bcv.ch/emploi')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.bcv.ch/job/Lausanne-Analyst/123456/')).toBe(true);
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
      expect(slugify('Gestionnaire spécialisé')).toBe('gestionnaire-specialise');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Conseiller bcv lausanne')).toBe('conseiller-bcv-lausanne');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference — mirrors the fields fetchAllBcvJobs()
    // actually emits, including the canton-gated address fields
    // (postalCode/streetAddress) per Non-Negotiable #3.
    const validJob = {
      id: 'bcv-abc123',
      slug: 'test-position-bcv-lausanne',
      slugByLocale: { fr: 'test-position-bcv-lausanne' },
      company: 'Banque Cantonale Vaudoise',
      companyKey: 'bcv',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://jobs.bcv.ch/job/Lausanne-Test-Position/123456/',
      source: 'Banque Cantonale Vaudoise Dedicated Parser (SuccessFactors)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      postalCode: '1003',
      streetAddress: 'Place Saint-François 14',
      employmentType: 'OTHER',
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

    it('includes canton-gated address fields for a Vaud (HQ) location', () => {
      expect(validJob.postalCode).toBe('1003');
      expect(validJob.streetAddress).toBe('Place Saint-François 14');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^bcv-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
