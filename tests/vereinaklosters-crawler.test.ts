import { describe, it, expect } from 'vitest';
import {
  VEREINAKLOSTERS_KEY,
  VEREINAKLOSTERS_COMPANY_NAME,
  isVereinaklostersJob,
  isTrustedDomain,
} from '../scripts/lib/vereinaklosters-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Vereina crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VEREINAKLOSTERS_KEY).toBe('vereinaklosters');
    expect(VEREINAKLOSTERS_COMPANY_NAME).toBe('Vereina');
  });

  // ── isCompanyJob ──
  describe('isVereinaklostersJob', () => {
    it('matches by companyKey', () => {
      expect(isVereinaklostersJob({ companyKey: 'vereinaklosters' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVereinaklostersJob({ company: 'Vereina' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVereinaklostersJob({ url: 'https://hotelcareer.ch/jobs/hotel-vereina-52746/123' })).toBe(true);
    });

    it('rejects unrelated HotelCareer listings', () => {
      expect(isVereinaklostersJob({ url: 'https://hotelcareer.ch/jobs/other-hotel-123' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isVereinaklostersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVereinaklostersJob(null)).toBe(false);
      expect(isVereinaklostersJob(undefined)).toBe(false);
      expect(isVereinaklostersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hotelcareer.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hotelcareer.ch/job/456')).toBe(true);
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
      expect(slugify('Developer vereinaklosters ch')).toBe('developer-vereinaklosters-ch');
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
      id: 'vereinaklosters-abc123',
      slug: 'test-position-vereinaklosters-ch',
      slugByLocale: { de: 'test-position-vereinaklosters-ch' },
      company: 'Vereina',
      companyKey: 'vereinaklosters',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: 'Vereina Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vereinaklosters-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
