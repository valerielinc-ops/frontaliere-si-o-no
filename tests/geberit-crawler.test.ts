import { describe, it, expect } from 'vitest';
import {
  GEBERIT_KEY,
  GEBERIT_COMPANY_NAME,
  isGeberitJob,
  isTrustedDomain,
} from '../scripts/lib/geberit-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Geberit crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GEBERIT_KEY).toBe('geberit');
    expect(GEBERIT_COMPANY_NAME).toBe('Geberit');
  });

  // ── isCompanyJob ──
  describe('isGeberitJob', () => {
    it('matches by companyKey', () => {
      expect(isGeberitJob({ companyKey: 'geberit' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGeberitJob({ company: 'Geberit' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGeberitJob({ url: 'https://geberit.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGeberitJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGeberitJob(null)).toBe(false);
      expect(isGeberitJob(undefined)).toBe(false);
      expect(isGeberitJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://geberit.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.geberit.com/job/456')).toBe(true);
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
      expect(slugify('Developer geberit ch')).toBe('developer-geberit-ch');
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
      id: 'geberit-abc123',
      slug: 'test-position-geberit-ch',
      slugByLocale: { de: 'test-position-geberit-ch' },
      company: 'Geberit',
      companyKey: 'geberit',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://geberit.com/jobs/test',
      source: 'Geberit Dedicated Parser',
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
      expect(validJob.id).toMatch(/^geberit-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
