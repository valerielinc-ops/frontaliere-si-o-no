import { describe, it, expect } from 'vitest';
import {
  BLATTERS_HOTEL_KEY,
  BLATTERS_HOTEL_COMPANY_NAME,
  isBlattersHotelJob,
  isTrustedDomain,
} from '../scripts/lib/blatters-hotel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Blatter's Arosa Hotel crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BLATTERS_HOTEL_KEY).toBe('blatters-hotel');
    expect(BLATTERS_HOTEL_COMPANY_NAME).toBe('Blatter's Arosa Hotel');
  });

  // ── isCompanyJob ──
  describe('isBlattersHotelJob', () => {
    it('matches by companyKey', () => {
      expect(isBlattersHotelJob({ companyKey: 'blatters-hotel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBlattersHotelJob({ company: 'Blatter's Arosa Hotel' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBlattersHotelJob({ url: 'https://hotelcareer.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBlattersHotelJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBlattersHotelJob(null)).toBe(false);
      expect(isBlattersHotelJob(undefined)).toBe(false);
      expect(isBlattersHotelJob({})).toBe(false);
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
      expect(slugify('Developer blatters-hotel ch')).toBe('developer-blatters-hotel-ch');
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
      id: 'blatters-hotel-abc123',
      slug: 'test-position-blatters-hotel-ch',
      slugByLocale: { de: 'test-position-blatters-hotel-ch' },
      company: 'Blatter's Arosa Hotel',
      companyKey: 'blatters-hotel',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: 'Blatter's Arosa Hotel Dedicated Parser',
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
      expect(validJob.id).toMatch(/^blatters-hotel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
