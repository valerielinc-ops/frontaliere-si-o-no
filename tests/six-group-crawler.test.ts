import { describe, it, expect } from 'vitest';
import {
  SIX_GROUP_KEY,
  SIX_GROUP_COMPANY_NAME,
  isSixGroupJob,
  isTrustedDomain,
} from '../scripts/lib/six-group-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SIX Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SIX_GROUP_KEY).toBe('six-group');
    expect(SIX_GROUP_COMPANY_NAME).toBe('SIX Group');
  });

  // ── isCompanyJob ──
  describe('isSixGroupJob', () => {
    it('matches by companyKey', () => {
      expect(isSixGroupJob({ companyKey: 'six-group' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSixGroupJob({ company: 'SIX Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSixGroupJob({ url: 'https://six-group.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSixGroupJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSixGroupJob(null)).toBe(false);
      expect(isSixGroupJob(undefined)).toBe(false);
      expect(isSixGroupJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://six-group.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.six-group.com/job/456')).toBe(true);
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
      expect(slugify('Developer six-group ch')).toBe('developer-six-group-ch');
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
      id: 'six-group-abc123',
      slug: 'test-position-six-group-ch',
      slugByLocale: { en: 'test-position-six-group-ch' },
      company: 'SIX Group',
      companyKey: 'six-group',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://six-group.com/jobs/test',
      source: 'SIX Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^six-group-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
