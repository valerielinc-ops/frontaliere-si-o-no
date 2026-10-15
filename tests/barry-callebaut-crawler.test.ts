import { describe, it, expect } from 'vitest';
import {
  BARRY_CALLEBAUT_KEY,
  BARRY_CALLEBAUT_COMPANY_NAME,
  isBarryCallebautJob,
  isTrustedDomain,
} from '../scripts/lib/barry-callebaut-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Barry Callebaut crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BARRY_CALLEBAUT_KEY).toBe('barry-callebaut');
    expect(BARRY_CALLEBAUT_COMPANY_NAME).toBe('Barry Callebaut');
  });

  // ── isCompanyJob ──
  describe('isBarryCallebautJob', () => {
    it('matches by companyKey', () => {
      expect(isBarryCallebautJob({ companyKey: 'barry-callebaut' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBarryCallebautJob({ company: 'Barry Callebaut' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBarryCallebautJob({ url: 'https://barry-callebaut.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBarryCallebautJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBarryCallebautJob(null)).toBe(false);
      expect(isBarryCallebautJob(undefined)).toBe(false);
      expect(isBarryCallebautJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://barry-callebaut.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.barry-callebaut.com/job/456')).toBe(true);
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
      expect(slugify('Developer barry-callebaut ch')).toBe('developer-barry-callebaut-ch');
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
      id: 'barry-callebaut-abc123',
      slug: 'test-position-barry-callebaut-ch',
      slugByLocale: { en: 'test-position-barry-callebaut-ch' },
      company: 'Barry Callebaut',
      companyKey: 'barry-callebaut',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://barry-callebaut.com/jobs/test',
      source: 'Barry Callebaut Dedicated Parser',
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
      expect(validJob.id).toMatch(/^barry-callebaut-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
