import { describe, it, expect } from 'vitest';
import {
  SWISS_RE_KEY,
  SWISS_RE_COMPANY_NAME,
  isSwissReJob,
  isTrustedDomain,
} from '../scripts/lib/swiss-re-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Swiss Re crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISS_RE_KEY).toBe('swiss-re');
    expect(SWISS_RE_COMPANY_NAME).toBe('Swiss Re');
  });

  // ── isCompanyJob ──
  describe('isSwissReJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissReJob({ companyKey: 'swiss-re' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissReJob({ company: 'Swiss Re' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissReJob({ url: 'https://swissre.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissReJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissReJob(null)).toBe(false);
      expect(isSwissReJob(undefined)).toBe(false);
      expect(isSwissReJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swissre.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swissre.ch/job/456')).toBe(true);
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
      expect(slugify('Developer swiss-re ch')).toBe('developer-swiss-re-ch');
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
      id: 'swiss-re-abc123',
      slug: 'test-position-swiss-re-ch',
      slugByLocale: { it: 'test-position-swiss-re-ch' },
      company: 'Swiss Re',
      companyKey: 'swiss-re',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swissre.ch/jobs/test',
      source: 'Swiss Re Dedicated Parser',
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
      expect(validJob.id).toMatch(/^swiss-re-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
