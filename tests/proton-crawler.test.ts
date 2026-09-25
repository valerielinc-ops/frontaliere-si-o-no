import { describe, it, expect } from 'vitest';
import {
  PROTON_KEY,
  PROTON_COMPANY_NAME,
  isProtonJob,
  isTrustedDomain,
} from '../scripts/lib/proton-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Proton crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PROTON_KEY).toBe('proton');
    expect(PROTON_COMPANY_NAME).toBe('Proton');
  });

  // ── isCompanyJob ──
  describe('isProtonJob', () => {
    it('matches by companyKey', () => {
      expect(isProtonJob({ companyKey: 'proton' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isProtonJob({ company: 'Proton' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isProtonJob({ url: 'https://proton.me/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isProtonJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isProtonJob(null)).toBe(false);
      expect(isProtonJob(undefined)).toBe(false);
      expect(isProtonJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://proton.me/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.proton.me/job/456')).toBe(true);
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
      expect(slugify('Developer proton ch')).toBe('developer-proton-ch');
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
      id: 'proton-abc123',
      slug: 'test-position-proton-ch',
      slugByLocale: { en: 'test-position-proton-ch' },
      company: 'Proton',
      companyKey: 'proton',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://proton.me/jobs/test',
      source: 'Proton Dedicated Parser',
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
      expect(validJob.id).toMatch(/^proton-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
