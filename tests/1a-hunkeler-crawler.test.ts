import { describe, it, expect } from 'vitest';
import {
  1A_HUNKELER_KEY,
  1A_HUNKELER_COMPANY_NAME,
  isC1aHunkelerJob,
  isTrustedDomain,
} from '../scripts/lib/1a-hunkeler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('1a-hunkeler crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(1A_HUNKELER_KEY).toBe('1a-hunkeler');
    expect(1A_HUNKELER_COMPANY_NAME).toBe('1a-hunkeler');
  });

  // ── isCompanyJob ──
  describe('isC1aHunkelerJob', () => {
    it('matches by companyKey', () => {
      expect(isC1aHunkelerJob({ companyKey: '1a-hunkeler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isC1aHunkelerJob({ company: '1a-hunkeler' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isC1aHunkelerJob({ url: 'https://1a-hunkeler.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isC1aHunkelerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isC1aHunkelerJob(null)).toBe(false);
      expect(isC1aHunkelerJob(undefined)).toBe(false);
      expect(isC1aHunkelerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://1a-hunkeler.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.1a-hunkeler.ch/job/456')).toBe(true);
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
      expect(slugify('Developer 1a-hunkeler ch')).toBe('developer-1a-hunkeler-ch');
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
      id: '1a-hunkeler-abc123',
      slug: 'test-position-1a-hunkeler-ch',
      slugByLocale: { de: 'test-position-1a-hunkeler-ch' },
      company: '1a-hunkeler',
      companyKey: '1a-hunkeler',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://1a-hunkeler.ch/jobs/test',
      source: '1a-hunkeler Dedicated Parser',
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
      expect(validJob.id).toMatch(/^1a-hunkeler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
