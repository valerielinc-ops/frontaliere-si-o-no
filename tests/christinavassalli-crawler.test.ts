import { describe, it, expect } from 'vitest';
import {
  CHRISTINAVASSALLI_KEY,
  CHRISTINAVASSALLI_COMPANY_NAME,
  isChristinavassalliJob,
  isTrustedDomain,
} from '../scripts/lib/christinavassalli-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHRISTINAVASSALLI_KEY).toBe('christinavassalli');
    expect(CHRISTINAVASSALLI_COMPANY_NAME).toBe('CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät');
  });

  // ── isCompanyJob ──
  describe('isChristinavassalliJob', () => {
    it('matches by companyKey', () => {
      expect(isChristinavassalliJob({ companyKey: 'christinavassalli' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChristinavassalliJob({ company: 'CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isChristinavassalliJob({ url: 'https://christinavassalli.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isChristinavassalliJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChristinavassalliJob(null)).toBe(false);
      expect(isChristinavassalliJob(undefined)).toBe(false);
      expect(isChristinavassalliJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://christinavassalli.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.christinavassalli.ch/job/456')).toBe(true);
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
      expect(slugify('Developer christinavassalli ch')).toBe('developer-christinavassalli-ch');
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
      id: 'christinavassalli-abc123',
      slug: 'test-position-christinavassalli-ch',
      slugByLocale: { de: 'test-position-christinavassalli-ch' },
      company: 'CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät',
      companyKey: 'christinavassalli',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://christinavassalli.ch/jobs/test',
      source: 'CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät Dedicated Parser',
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
      expect(validJob.id).toMatch(/^christinavassalli-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
