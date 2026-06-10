import { describe, it, expect } from 'vitest';
import {
  DUFERCO_KEY,
  DUFERCO_COMPANY_NAME,
  isDufercoJob,
  isTrustedDomain,
} from '../scripts/lib/duferco-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Duferco crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DUFERCO_KEY).toBe('duferco');
    expect(DUFERCO_COMPANY_NAME).toBe('Duferco');
  });

  // ── isCompanyJob ──
  describe('isDufercoJob', () => {
    it('matches by companyKey', () => {
      expect(isDufercoJob({ companyKey: 'duferco' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDufercoJob({ company: 'Duferco' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDufercoJob({ url: 'https://duferco.talentics.ai/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDufercoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDufercoJob(null)).toBe(false);
      expect(isDufercoJob(undefined)).toBe(false);
      expect(isDufercoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://duferco.talentics.ai/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.duferco.talentics.ai/job/456')).toBe(true);
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
      expect(slugify('Developer duferco ch')).toBe('developer-duferco-ch');
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
      id: 'duferco-abc123',
      slug: 'test-position-duferco-ch',
      slugByLocale: { en: 'test-position-duferco-ch' },
      company: 'Duferco',
      companyKey: 'duferco',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://duferco.talentics.ai/jobs/test',
      source: 'Duferco Dedicated Parser',
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
      expect(validJob.id).toMatch(/^duferco-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
