import { describe, it, expect } from 'vitest';
import {
  SCHWEIZERHOF_FLIMS_KEY,
  SCHWEIZERHOF_FLIMS_COMPANY_NAME,
  isSchweizerhofFlimsJob,
  isTrustedDomain,
} from '../scripts/lib/schweizerhof-flims-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Schweizerhof crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SCHWEIZERHOF_FLIMS_KEY).toBe('schweizerhof-flims');
    expect(SCHWEIZERHOF_FLIMS_COMPANY_NAME).toBe('Schweizerhof');
  });

  // ── isCompanyJob ──
  describe('isSchweizerhofFlimsJob', () => {
    it('matches by companyKey', () => {
      expect(isSchweizerhofFlimsJob({ companyKey: 'schweizerhof-flims' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSchweizerhofFlimsJob({ company: 'Schweizerhof' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSchweizerhofFlimsJob({ url: 'https://hotelcareer.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSchweizerhofFlimsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSchweizerhofFlimsJob(null)).toBe(false);
      expect(isSchweizerhofFlimsJob(undefined)).toBe(false);
      expect(isSchweizerhofFlimsJob({})).toBe(false);
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
      expect(slugify('Developer schweizerhof-flims ch')).toBe('developer-schweizerhof-flims-ch');
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
      id: 'schweizerhof-flims-abc123',
      slug: 'test-position-schweizerhof-flims-ch',
      slugByLocale: { de: 'test-position-schweizerhof-flims-ch' },
      company: 'Schweizerhof',
      companyKey: 'schweizerhof-flims',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: 'Schweizerhof Dedicated Parser',
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
      expect(validJob.id).toMatch(/^schweizerhof-flims-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
