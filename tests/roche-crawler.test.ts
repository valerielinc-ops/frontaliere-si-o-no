import { describe, it, expect } from 'vitest';
import {
  ROCHE_KEY,
  ROCHE_COMPANY_NAME,
  isRocheJob,
  isTrustedDomain,
} from '../scripts/lib/roche-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Roche crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ROCHE_KEY).toBe('roche');
    expect(ROCHE_COMPANY_NAME).toBe('Roche');
  });

  // ── isCompanyJob ──
  describe('isRocheJob', () => {
    it('matches by companyKey', () => {
      expect(isRocheJob({ companyKey: 'roche' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRocheJob({ company: 'Roche' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRocheJob({ url: 'https://roche.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRocheJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRocheJob(null)).toBe(false);
      expect(isRocheJob(undefined)).toBe(false);
      expect(isRocheJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://roche.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.roche.com/job/456')).toBe(true);
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
      expect(slugify('Developer roche ch')).toBe('developer-roche-ch');
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
      id: 'roche-abc123',
      slug: 'test-position-roche-ch',
      slugByLocale: { it: 'test-position-roche-ch' },
      company: 'Roche',
      companyKey: 'roche',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://roche.com/jobs/test',
      source: 'Roche Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^roche-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
