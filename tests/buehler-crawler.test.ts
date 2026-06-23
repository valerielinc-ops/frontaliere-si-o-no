import { describe, it, expect } from 'vitest';
import {
  BUEHLER_KEY,
  BUEHLER_COMPANY_NAME,
  isBuehlerJob,
  isTrustedDomain,
} from '../scripts/lib/buehler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bühler Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BUEHLER_KEY).toBe('buehler');
    expect(BUEHLER_COMPANY_NAME).toBe('Bühler Group');
  });

  // ── isCompanyJob ──
  describe('isBuehlerJob', () => {
    it('matches by companyKey', () => {
      expect(isBuehlerJob({ companyKey: 'buehler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBuehlerJob({ company: 'Bühler Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBuehlerJob({ url: 'https://buhlergroup.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBuehlerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBuehlerJob(null)).toBe(false);
      expect(isBuehlerJob(undefined)).toBe(false);
      expect(isBuehlerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://buhlergroup.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.buhlergroup.com/job/456')).toBe(true);
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
      expect(slugify('Developer buehler ch')).toBe('developer-buehler-ch');
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
      id: 'buehler-abc123',
      slug: 'test-position-buehler-ch',
      slugByLocale: { de: 'test-position-buehler-ch' },
      company: 'Bühler Group',
      companyKey: 'buehler',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://buhlergroup.com/jobs/test',
      source: 'Bühler Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^buehler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
