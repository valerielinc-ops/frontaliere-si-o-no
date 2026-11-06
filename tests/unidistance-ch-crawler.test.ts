import { describe, it, expect } from 'vitest';
import {
  UNIDISTANCE_CH_KEY,
  UNIDISTANCE_CH_COMPANY_NAME,
  isUnidistanceChJob,
  isTrustedDomain,
} from '../scripts/lib/unidistance-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('UniDistance Suisse crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(UNIDISTANCE_CH_KEY).toBe('unidistance-ch');
    expect(UNIDISTANCE_CH_COMPANY_NAME).toBe('UniDistance Suisse');
  });

  // ── isCompanyJob ──
  describe('isUnidistanceChJob', () => {
    it('matches by companyKey', () => {
      expect(isUnidistanceChJob({ companyKey: 'unidistance-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUnidistanceChJob({ company: 'UniDistance Suisse' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUnidistanceChJob({ url: 'https://fernuni.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUnidistanceChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUnidistanceChJob(null)).toBe(false);
      expect(isUnidistanceChJob(undefined)).toBe(false);
      expect(isUnidistanceChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://fernuni.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.fernuni.ch/job/456')).toBe(true);
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
      expect(slugify('Developer unidistance-ch ch')).toBe('developer-unidistance-ch-ch');
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
      id: 'unidistance-ch-abc123',
      slug: 'test-position-unidistance-ch-ch',
      slugByLocale: { de: 'test-position-unidistance-ch-ch' },
      company: 'UniDistance Suisse',
      companyKey: 'unidistance-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://fernuni.ch/jobs/test',
      source: 'UniDistance Suisse Dedicated Parser',
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
      expect(validJob.id).toMatch(/^unidistance-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
