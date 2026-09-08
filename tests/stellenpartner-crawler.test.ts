import { describe, it, expect } from 'vitest';
import {
  STELLENPARTNER_KEY,
  STELLENPARTNER_COMPANY_NAME,
  isStellenpartnerJob,
  isTrustedDomain,
} from '../scripts/lib/stellenpartner-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stellenpartner AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STELLENPARTNER_KEY).toBe('stellenpartner');
    expect(STELLENPARTNER_COMPANY_NAME).toBe('Stellenpartner AG');
  });

  // ── isCompanyJob ──
  describe('isStellenpartnerJob', () => {
    it('matches by companyKey', () => {
      expect(isStellenpartnerJob({ companyKey: 'stellenpartner' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStellenpartnerJob({ company: 'Stellenpartner AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStellenpartnerJob({ url: 'https://stellenpartner.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStellenpartnerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStellenpartnerJob(null)).toBe(false);
      expect(isStellenpartnerJob(undefined)).toBe(false);
      expect(isStellenpartnerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stellenpartner.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stellenpartner.ch/job/456')).toBe(true);
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
      expect(slugify('Developer stellenpartner ch')).toBe('developer-stellenpartner-ch');
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
      id: 'stellenpartner-abc123',
      slug: 'test-position-stellenpartner-ch',
      slugByLocale: { de: 'test-position-stellenpartner-ch' },
      company: 'Stellenpartner AG',
      companyKey: 'stellenpartner',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stellenpartner.ch/jobs/test',
      source: 'Stellenpartner AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stellenpartner-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
