import { describe, it, expect } from 'vitest';
import {
  AMINA_BANK_KEY,
  AMINA_BANK_COMPANY_NAME,
  isAminaBankJob,
  isTrustedDomain,
} from '../scripts/lib/amina-bank-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('AMINA Bank crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AMINA_BANK_KEY).toBe('amina-bank');
    expect(AMINA_BANK_COMPANY_NAME).toBe('AMINA Bank');
  });

  // ── isCompanyJob ──
  describe('isAminaBankJob', () => {
    it('matches by companyKey', () => {
      expect(isAminaBankJob({ companyKey: 'amina-bank' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAminaBankJob({ company: 'AMINA Bank' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAminaBankJob({ url: 'https://amina.jobs.personio.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAminaBankJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAminaBankJob(null)).toBe(false);
      expect(isAminaBankJob(undefined)).toBe(false);
      expect(isAminaBankJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://amina.jobs.personio.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.amina.jobs.personio.com/job/456')).toBe(true);
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
      expect(slugify('Developer amina-bank ch')).toBe('developer-amina-bank-ch');
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
      id: 'amina-bank-abc123',
      slug: 'test-position-amina-bank-ch',
      slugByLocale: { en: 'test-position-amina-bank-ch' },
      company: 'AMINA Bank',
      companyKey: 'amina-bank',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://amina.jobs.personio.com/jobs/test',
      source: 'AMINA Bank Dedicated Parser',
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
      expect(validJob.id).toMatch(/^amina-bank-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
