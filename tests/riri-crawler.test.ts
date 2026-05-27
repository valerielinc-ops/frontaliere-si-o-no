import { describe, it, expect } from 'vitest';
import {
  RIRI_KEY,
  RIRI_COMPANY_NAME,
  isRiriJob,
  isTrustedDomain,
} from '../scripts/lib/riri-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Riri Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RIRI_KEY).toBe('riri');
    expect(RIRI_COMPANY_NAME).toBe('Riri Group');
  });

  // ── isCompanyJob ──
  describe('isRiriJob', () => {
    it('matches by companyKey', () => {
      expect(isRiriJob({ companyKey: 'riri' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRiriJob({ company: 'Riri Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRiriJob({ url: 'https://rfriri.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRiriJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRiriJob(null)).toBe(false);
      expect(isRiriJob(undefined)).toBe(false);
      expect(isRiriJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://rfriri.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.rfriri.com/job/456')).toBe(true);
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
      expect(slugify('Developer riri ch')).toBe('developer-riri-ch');
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
      id: 'riri-abc123',
      slug: 'test-position-riri-ch',
      slugByLocale: { it: 'test-position-riri-ch' },
      company: 'Riri Group',
      companyKey: 'riri',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://rfriri.com/jobs/test',
      source: 'Riri Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^riri-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
