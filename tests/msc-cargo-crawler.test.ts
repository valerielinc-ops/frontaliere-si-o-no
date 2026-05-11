import { describe, it, expect } from 'vitest';
import {
  MSC_CARGO_KEY,
  MSC_CARGO_COMPANY_NAME,
  isMscCargoJob,
  isTrustedDomain,
} from '../scripts/lib/msc-cargo-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('MSC Cargo crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MSC_CARGO_KEY).toBe('msc-cargo');
    expect(MSC_CARGO_COMPANY_NAME).toBe('MSC Cargo');
  });

  // ── isCompanyJob ──
  describe('isMscCargoJob', () => {
    it('matches by companyKey', () => {
      expect(isMscCargoJob({ companyKey: 'msc-cargo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMscCargoJob({ company: 'MSC Cargo' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMscCargoJob({ url: 'https://msc.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMscCargoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMscCargoJob(null)).toBe(false);
      expect(isMscCargoJob(undefined)).toBe(false);
      expect(isMscCargoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://msc.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.msc.com/job/456')).toBe(true);
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
      expect(slugify('Developer msc-cargo ch')).toBe('developer-msc-cargo-ch');
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
      id: 'msc-cargo-abc123',
      slug: 'test-position-msc-cargo-ch',
      slugByLocale: { en: 'test-position-msc-cargo-ch' },
      company: 'MSC Cargo',
      companyKey: 'msc-cargo',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://msc.com/jobs/test',
      source: 'MSC Cargo Dedicated Parser',
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
      expect(validJob.id).toMatch(/^msc-cargo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
