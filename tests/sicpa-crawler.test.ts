import { describe, it, expect } from 'vitest';
import {
  SICPA_KEY,
  SICPA_COMPANY_NAME,
  isSicpaJob,
  isTrustedDomain,
} from '../scripts/lib/sicpa-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SICPA SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SICPA_KEY).toBe('sicpa');
    expect(SICPA_COMPANY_NAME).toBe('SICPA SA');
  });

  // ── isCompanyJob ──
  describe('isSicpaJob', () => {
    it('matches by companyKey', () => {
      expect(isSicpaJob({ companyKey: 'sicpa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSicpaJob({ company: 'SICPA SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSicpaJob({ url: 'https://sicpa.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSicpaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSicpaJob(null)).toBe(false);
      expect(isSicpaJob(undefined)).toBe(false);
      expect(isSicpaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sicpa.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.sicpa.com/job/456')).toBe(true);
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
      expect(slugify('Developer sicpa ch')).toBe('developer-sicpa-ch');
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
      id: 'sicpa-abc123',
      slug: 'test-position-sicpa-ch',
      slugByLocale: { fr: 'test-position-sicpa-ch' },
      company: 'SICPA SA',
      companyKey: 'sicpa',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Prilly',
      canton: 'VD',
      url: 'https://sicpa.com/jobs/test',
      source: 'SICPA SA Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^sicpa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
