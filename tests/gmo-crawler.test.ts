import { describe, it, expect } from 'vitest';
import {
  GMO_KEY,
  GMO_COMPANY_NAME,
  isGmoJob,
  isTrustedDomain,
} from '../scripts/lib/gmo-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('gmo crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GMO_KEY).toBe('gmo');
    expect(GMO_COMPANY_NAME).toBe('gmo');
  });

  // ── isCompanyJob ──
  describe('isGmoJob', () => {
    it('matches by companyKey', () => {
      expect(isGmoJob({ companyKey: 'gmo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGmoJob({ company: 'gmo' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGmoJob({ url: 'https://arsante.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGmoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGmoJob(null)).toBe(false);
      expect(isGmoJob(undefined)).toBe(false);
      expect(isGmoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://arsante.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.arsante.ch/job/456')).toBe(true);
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
      expect(slugify('Developer gmo ch')).toBe('developer-gmo-ch');
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
      id: 'gmo-abc123',
      slug: 'test-position-gmo-ch',
      slugByLocale: { fr: 'test-position-gmo-ch' },
      company: 'gmo',
      companyKey: 'gmo',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://arsante.ch/jobs/test',
      source: 'gmo Dedicated Parser',
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
      expect(validJob.id).toMatch(/^gmo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
