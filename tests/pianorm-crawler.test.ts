import { describe, it, expect } from 'vitest';
import {
  PIANORM_KEY,
  PIANORM_COMPANY_NAME,
  isPianormJob,
  isTrustedDomain,
  buildPianormJobFromListing,
} from '../scripts/lib/pianorm-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('pianorm crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PIANORM_KEY).toBe('pianorm');
    expect(PIANORM_COMPANY_NAME).toBe('pianorm');
  });

  // ── isCompanyJob ──
  describe('isPianormJob', () => {
    it('matches by companyKey', () => {
      expect(isPianormJob({ companyKey: 'pianorm' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPianormJob({ company: 'pianorm' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPianormJob({ url: 'https://pianorm.ch/jobs/123' })).toBe(true);
    });

    it('rejects a URL that only mentions pianorm.ch outside its hostname', () => {
      expect(isPianormJob({
        companyKey: 'other-company',
        company: 'Other',
        url: 'https://jobs.example.test/apply?next=https://pianorm.ch/job/',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isPianormJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPianormJob(null)).toBe(false);
      expect(isPianormJob(undefined)).toBe(false);
      expect(isPianormJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pianorm.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pianorm.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('source-backed country contract', () => {
    const listing = (overrides: Record<string, unknown> = {}) => ({
      title: 'Maschinist oder Fertigungsspezialist',
      description: 'Source description for a Swiss vacancy.',
      location: 'Illnau, ZH',
      addressLocality: 'Illnau',
      addressRegion: 'ZH',
      addressCountry: 'Schweiz',
      postalCode: '8308',
      url: 'https://www.pianorm.ch/job/maschinist/',
      ...overrides,
    });

    it('publishes the canonical CH code after validating a source country label', () => {
      expect(buildPianormJobFromListing(listing())).toMatchObject({
        country: 'CH',
        addressCountry: 'CH',
        location: 'Illnau, ZH',
        canton: 'ZH',
      });
    });

    it('rejects explicit foreign country evidence even with a Swiss-looking locality', () => {
      expect(buildPianormJobFromListing(listing({ addressCountry: 'France' }))).toBeNull();
    });

    it('rejects missing country when the source location cannot prove a Swiss canton', () => {
      expect(buildPianormJobFromListing(listing({
        addressCountry: '',
        location: 'Remote',
        addressLocality: '',
        addressRegion: '',
      }))).toBeNull();
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
      expect(slugify('Developer pianorm ch')).toBe('developer-pianorm-ch');
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
      id: 'pianorm-abc123',
      slug: 'test-position-pianorm-ch',
      slugByLocale: { de: 'test-position-pianorm-ch' },
      company: 'pianorm',
      companyKey: 'pianorm',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://pianorm.ch/jobs/test',
      source: 'pianorm Dedicated Parser',
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
      expect(validJob.id).toMatch(/^pianorm-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
