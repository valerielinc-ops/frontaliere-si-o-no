import { describe, it, expect } from 'vitest';
import {
  STELLENTREFF_KEY,
  STELLENTREFF_COMPANY_NAME,
  isStellentreffJob,
  isTrustedDomain,
} from '../scripts/lib/stellentreff-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stellentreff AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STELLENTREFF_KEY).toBe('stellentreff');
    expect(STELLENTREFF_COMPANY_NAME).toBe('Stellentreff AG');
  });

  // ── isCompanyJob ──
  describe('isStellentreffJob', () => {
    it('matches by companyKey', () => {
      expect(isStellentreffJob({ companyKey: 'stellentreff' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStellentreffJob({ company: 'Stellentreff AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStellentreffJob({ url: 'https://stellentreff.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStellentreffJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStellentreffJob(null)).toBe(false);
      expect(isStellentreffJob(undefined)).toBe(false);
      expect(isStellentreffJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stellentreff.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stellentreff.ch/job/456')).toBe(true);
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
      expect(slugify('Developer stellentreff ch')).toBe('developer-stellentreff-ch');
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
      id: 'stellentreff-abc123',
      slug: 'test-position-stellentreff-ch',
      slugByLocale: { de: 'test-position-stellentreff-ch' },
      company: 'Stellentreff AG',
      companyKey: 'stellentreff',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stellentreff.ch/jobs/test',
      source: 'Stellentreff AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stellentreff-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
