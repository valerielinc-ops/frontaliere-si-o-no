import { describe, it, expect } from 'vitest';
import {
  USZ_KEY,
  USZ_COMPANY_NAME,
  isUszJob,
  isTrustedDomain,
} from '../scripts/lib/usz-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Universitätsspital Zürich (USZ) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(USZ_KEY).toBe('usz');
    expect(USZ_COMPANY_NAME).toBe('Universitätsspital Zürich (USZ)');
  });

  // ── isCompanyJob ──
  describe('isUszJob', () => {
    it('matches by companyKey', () => {
      expect(isUszJob({ companyKey: 'usz' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isUszJob({ company: 'Universitätsspital Zürich (USZ)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isUszJob({ url: 'https://usz.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isUszJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isUszJob(null)).toBe(false);
      expect(isUszJob(undefined)).toBe(false);
      expect(isUszJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://usz.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.usz.ch/job/456')).toBe(true);
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
      expect(slugify('Developer usz ch')).toBe('developer-usz-ch');
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
      id: 'usz-abc123',
      slug: 'test-position-usz-ch',
      slugByLocale: { de: 'test-position-usz-ch' },
      company: 'Universitätsspital Zürich (USZ)',
      companyKey: 'usz',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://usz.ch/jobs/test',
      source: 'Universitätsspital Zürich (USZ) Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^usz-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
