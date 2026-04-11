import { describe, it, expect } from 'vitest';
import {
  MARRIOTT_KEY,
  MARRIOTT_COMPANY_NAME,
  MARRIOTT_COMPANY_DOMAIN,
  isMarriottJob,
  isTrustedDomain,
} from '../scripts/lib/marriott-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Marriott International crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MARRIOTT_KEY).toBe('marriott');
    expect(MARRIOTT_COMPANY_NAME).toBe('Marriott International');
    expect(MARRIOTT_COMPANY_DOMAIN).toBe('marriott.com');
  });

  // ── isCompanyJob ──
  describe('isMarriottJob', () => {
    it('matches by companyKey', () => {
      expect(isMarriottJob({ companyKey: 'marriott' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMarriottJob({ company: 'Marriott International' })).toBe(true);
    });

    it('matches by partial company name', () => {
      expect(isMarriottJob({ company: 'Marriott' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMarriottJob({ url: 'https://marriott.com/jobs/123' })).toBe(true);
    });

    it('matches by careers subdomain URL', () => {
      expect(isMarriottJob({ url: 'https://careers.marriott.com/bar-supervisor/job/ABC123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMarriottJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMarriottJob(null)).toBe(false);
      expect(isMarriottJob(undefined)).toBe(false);
      expect(isMarriottJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://marriott.com/careers/job-123')).toBe(true);
    });

    it('trusts careers subdomain', () => {
      expect(isTrustedDomain('https://careers.marriott.com/job/456')).toBe(true);
    });

    it('trusts Oracle Cloud apply URLs', () => {
      expect(isTrustedDomain('https://ejwl.fa.us2.oraclecloud.com:443/hcmUI/CandidateExperience/en/sites/MI_CS_1/job/26043183/apply/email')).toBe(true);
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
      expect(slugify('Developer marriott ch')).toBe('developer-marriott-ch');
    });

    it('handles Marriott job titles with brands', () => {
      const slug = slugify('Bar Supervisor (long term) - W VERBIER marriott verbier');
      expect(slug).toMatch(/^bar-supervisor/);
      expect(slug).toContain('marriott');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (matching actual Marriott API fields)
    const validJob = {
      id: 'marriott-abc123def456',
      slug: 'bar-supervisor-long-term-w-verbier-marriott-verbier',
      slugByLocale: { en: 'bar-supervisor-long-term-w-verbier-marriott-verbier' },
      company: 'Marriott International',
      companyKey: 'marriott',
      companyDomain: 'marriott.com',
      title: 'Bar Supervisor (long term) - W VERBIER',
      titleByLocale: { en: 'Bar Supervisor (long term) - W VERBIER' },
      description: 'A test job description for the Bar Supervisor position at W Verbier hotel in Switzerland.',
      descriptionByLocale: { en: 'A test job description for the Bar Supervisor position at W Verbier hotel in Switzerland.' },
      location: 'Verbier',
      canton: 'VS',
      url: 'https://careers.marriott.com/bar-supervisor-long-term-w-verbier/job/ABC123',
      source: 'Marriott International Dedicated Parser (Paradox API)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Verbier',
      streetAddress: 'Rue de Medran 70',
      postalCode: '1936',
      addressCountry: 'CH',
      country: 'CH',
      category: 'hospitality-food-beverage',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Hôtellerie / Hospitality',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-04-11',
      applyUrl: 'https://ejwl.fa.us2.oraclecloud.com:443/hcmUI/CandidateExperience/en/sites/MI_CS_1/job/26043183/apply/email',
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

    it('has all SEO-mandatory fields', () => {
      const seoFields = [
        'addressLocality', 'postalCode', 'streetAddress',
        'employmentType', 'addressCountry',
      ];
      for (const field of seoFields) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^marriott-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is VS for Verbier', () => {
      expect(validJob.canton).toBe('VS');
    });

    it('sector is hospitality', () => {
      expect(validJob.sector).toContain('Hospitality');
    });
  });
});
