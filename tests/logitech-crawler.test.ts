import { describe, it, expect } from 'vitest';
import {
  LOGITECH_KEY,
  LOGITECH_COMPANY_NAME,
  isLogitechJob,
  isTrustedDomain,
} from '../scripts/lib/logitech-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Logitech crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LOGITECH_KEY).toBe('logitech');
    expect(LOGITECH_COMPANY_NAME).toBe('Logitech');
  });

  // ── isCompanyJob ──
  describe('isLogitechJob', () => {
    it('matches by companyKey', () => {
      expect(isLogitechJob({ companyKey: 'logitech' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLogitechJob({ company: 'Logitech' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLogitechJob({ url: 'https://logitech.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLogitechJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLogitechJob(null)).toBe(false);
      expect(isLogitechJob(undefined)).toBe(false);
      expect(isLogitechJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://logitech.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.logitech.com/job/456')).toBe(true);
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
      expect(slugify('Developer logitech ch')).toBe('developer-logitech-ch');
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
      id: 'logitech-abc123',
      slug: 'test-position-logitech-ch',
      slugByLocale: { it: 'test-position-logitech-ch' },
      company: 'Logitech',
      companyKey: 'logitech',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://logitech.com/jobs/test',
      source: 'Logitech Dedicated Parser',
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
      expect(validJob.id).toMatch(/^logitech-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
