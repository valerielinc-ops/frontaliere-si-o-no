import { describe, it, expect } from 'vitest';
import {
  SZB_CHB_KEY,
  SZB_CHB_COMPANY_NAME,
  isSzbChbJob,
  isTrustedDomain,
} from '../scripts/lib/szb-chb-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spitalzentrum Biel / Centre hospitalier Bienne crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SZB_CHB_KEY).toBe('szb-chb');
    expect(SZB_CHB_COMPANY_NAME).toBe('Spitalzentrum Biel / Centre hospitalier Bienne');
  });

  // ── isCompanyJob ──
  describe('isSzbChbJob', () => {
    it('matches by companyKey', () => {
      expect(isSzbChbJob({ companyKey: 'szb-chb' })).toBe(true);
    });

    it('matches by Umantis vanity URL', () => {
      expect(isSzbChbJob({ url: 'https://jobs.szb-chb.ch/Vacancies/4306/Description/1' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSzbChbJob({ url: 'https://szb-chb.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSzbChbJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSzbChbJob(null)).toBe(false);
      expect(isSzbChbJob(undefined)).toBe(false);
      expect(isSzbChbJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://szb-chb.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.szb-chb.ch/job/456')).toBe(true);
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
      expect(slugify('Developer szb-chb ch')).toBe('developer-szb-chb-ch');
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
      id: 'szb-chb-abc123',
      slug: 'test-position-szb-chb-ch',
      slugByLocale: { de: 'test-position-szb-chb-ch' },
      company: 'Spitalzentrum Biel / Centre hospitalier Bienne',
      companyKey: 'szb-chb',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://szb-chb.ch/jobs/test',
      source: 'Spitalzentrum Biel / Centre hospitalier Bienne Dedicated Parser',
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
      expect(validJob.id).toMatch(/^szb-chb-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
