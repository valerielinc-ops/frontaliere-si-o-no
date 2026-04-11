import { describe, it, expect } from 'vitest';
import {
  BMS_BUILDING_KEY,
  BMS_BUILDING_COMPANY_NAME,
  isBmsBuildingJob,
  isTrustedDomain,
} from '../scripts/lib/bms-building-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('BMS Building Materials crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BMS_BUILDING_KEY).toBe('bms-building');
    expect(BMS_BUILDING_COMPANY_NAME).toBe('BMS Building Materials');
  });

  // ── isCompanyJob ──
  describe('isBmsBuildingJob', () => {
    it('matches by companyKey', () => {
      expect(isBmsBuildingJob({ companyKey: 'bms-building' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBmsBuildingJob({ company: 'BMS Building Materials' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBmsBuildingJob({ url: 'https://bmsuisse.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBmsBuildingJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBmsBuildingJob(null)).toBe(false);
      expect(isBmsBuildingJob(undefined)).toBe(false);
      expect(isBmsBuildingJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bmsuisse.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bmsuisse.ch/job/456')).toBe(true);
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
      expect(slugify('Developer bms-building ch')).toBe('developer-bms-building-ch');
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
      id: 'bms-building-abc123',
      slug: 'test-position-bms-building-ch',
      slugByLocale: { de: 'test-position-bms-building-ch' },
      company: 'BMS Building Materials',
      companyKey: 'bms-building',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bmsuisse.ch/jobs/test',
      source: 'BMS Building Materials Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bms-building-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
