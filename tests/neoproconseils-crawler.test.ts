import { describe, it, expect } from 'vitest';
import {
  NEOPROCONSEILS_KEY,
  NEOPROCONSEILS_COMPANY_NAME,
  isNeoproconseilsJob,
  isTrustedDomain,
} from '../scripts/lib/neoproconseils-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('NEO Pro conseils SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NEOPROCONSEILS_KEY).toBe('neoproconseils');
    expect(NEOPROCONSEILS_COMPANY_NAME).toBe('NEO Pro conseils SA');
  });

  // ── isCompanyJob ──
  describe('isNeoproconseilsJob', () => {
    it('matches by companyKey', () => {
      expect(isNeoproconseilsJob({ companyKey: 'neoproconseils' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNeoproconseilsJob({ company: 'NEO Pro conseils SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNeoproconseilsJob({ url: 'https://neoproconseils.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNeoproconseilsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNeoproconseilsJob(null)).toBe(false);
      expect(isNeoproconseilsJob(undefined)).toBe(false);
      expect(isNeoproconseilsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://neoproconseils.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.neoproconseils.ch/job/456')).toBe(true);
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
      expect(slugify('Developer neoproconseils ch')).toBe('developer-neoproconseils-ch');
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
      id: 'neoproconseils-abc123',
      slug: 'test-position-neoproconseils-ch',
      slugByLocale: { fr: 'test-position-neoproconseils-ch' },
      company: 'NEO Pro conseils SA',
      companyKey: 'neoproconseils',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://neoproconseils.ch/jobs/test',
      source: 'NEO Pro conseils SA Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^neoproconseils-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
