import { describe, it, expect } from 'vitest';
import {
  HUNTSMAN_KEY,
  HUNTSMAN_COMPANY_NAME,
  isHuntsmanJob,
  isTrustedDomain,
} from '../scripts/lib/huntsman-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Huntsman Corporation crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HUNTSMAN_KEY).toBe('huntsman');
    expect(HUNTSMAN_COMPANY_NAME).toBe('Huntsman Corporation');
  });

  // ── isCompanyJob ──
  describe('isHuntsmanJob', () => {
    it('matches by companyKey', () => {
      expect(isHuntsmanJob({ companyKey: 'huntsman' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHuntsmanJob({ company: 'Huntsman Corporation' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHuntsmanJob({ url: 'https://huntsman.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHuntsmanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHuntsmanJob(null)).toBe(false);
      expect(isHuntsmanJob(undefined)).toBe(false);
      expect(isHuntsmanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://huntsman.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.huntsman.com/job/456')).toBe(true);
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
      expect(slugify('Developer huntsman ch')).toBe('developer-huntsman-ch');
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
      id: 'huntsman-abc123',
      slug: 'test-position-huntsman-ch',
      slugByLocale: { en: 'test-position-huntsman-ch' },
      company: 'Huntsman Corporation',
      companyKey: 'huntsman',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://huntsman.com/jobs/test',
      source: 'Huntsman Corporation Dedicated Parser',
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
      expect(validJob.id).toMatch(/^huntsman-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
