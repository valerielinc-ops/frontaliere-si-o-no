import { describe, it, expect } from 'vitest';
import {
  DATA_UNIT_AG_KEY,
  DATA_UNIT_AG_COMPANY_NAME,
  isDataUnitAgJob,
  isTrustedDomain,
} from '../scripts/lib/data-unit-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('DATA UNIT AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DATA_UNIT_AG_KEY).toBe('data-unit-ag');
    expect(DATA_UNIT_AG_COMPANY_NAME).toBe('DATA UNIT AG');
  });

  // ── isCompanyJob ──
  describe('isDataUnitAgJob', () => {
    it('matches by companyKey', () => {
      expect(isDataUnitAgJob({ companyKey: 'data-unit-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDataUnitAgJob({ company: 'DATA UNIT AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDataUnitAgJob({ url: 'https://dataunit.jobs.personio.de/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDataUnitAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDataUnitAgJob(null)).toBe(false);
      expect(isDataUnitAgJob(undefined)).toBe(false);
      expect(isDataUnitAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://dataunit.jobs.personio.de/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.dataunit.jobs.personio.de/job/456')).toBe(true);
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
      expect(slugify('Developer data-unit-ag ch')).toBe('developer-data-unit-ag-ch');
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
      id: 'data-unit-ag-abc123',
      slug: 'test-position-data-unit-ag-ch',
      slugByLocale: { en: 'test-position-data-unit-ag-ch' },
      company: 'DATA UNIT AG',
      companyKey: 'data-unit-ag',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://dataunit.jobs.personio.de/jobs/test',
      source: 'DATA UNIT AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^data-unit-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
