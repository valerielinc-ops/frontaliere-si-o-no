import { describe, it, expect } from 'vitest';
import {
  TETHER_KEY,
  TETHER_COMPANY_NAME,
  isTetherJob,
  isTrustedDomain,
} from '../scripts/lib/tether-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Tether Operations crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TETHER_KEY).toBe('tether');
    expect(TETHER_COMPANY_NAME).toBe('Tether Operations');
  });

  // ── isCompanyJob ──
  describe('isTetherJob', () => {
    it('matches by companyKey', () => {
      expect(isTetherJob({ companyKey: 'tether' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTetherJob({ company: 'Tether Operations' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTetherJob({ url: 'https://tether.io/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTetherJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTetherJob(null)).toBe(false);
      expect(isTetherJob(undefined)).toBe(false);
      expect(isTetherJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://tether.io/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.tether.io/job/456')).toBe(true);
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
      expect(slugify('Developer tether ch')).toBe('developer-tether-ch');
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
      id: 'tether-abc123',
      slug: 'test-position-tether-ch',
      slugByLocale: { en: 'test-position-tether-ch' },
      company: 'Tether Operations',
      companyKey: 'tether',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://tether.io/jobs/test',
      source: 'Tether Operations Dedicated Parser',
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
      expect(validJob.id).toMatch(/^tether-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
