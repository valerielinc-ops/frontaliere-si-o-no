import { describe, it, expect } from 'vitest';
import {
  STADLER_RAIL_KEY,
  STADLER_RAIL_COMPANY_NAME,
  isStadlerRailJob,
  isTrustedDomain,
} from '../scripts/lib/stadler-rail-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stadler Rail crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADLER_RAIL_KEY).toBe('stadler-rail');
    expect(STADLER_RAIL_COMPANY_NAME).toBe('Stadler Rail');
  });

  // ── isCompanyJob ──
  describe('isStadlerRailJob', () => {
    it('matches by companyKey', () => {
      expect(isStadlerRailJob({ companyKey: 'stadler-rail' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadlerRailJob({ company: 'Stadler Rail' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStadlerRailJob({ url: 'https://stadlerrail.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStadlerRailJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadlerRailJob(null)).toBe(false);
      expect(isStadlerRailJob(undefined)).toBe(false);
      expect(isStadlerRailJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stadlerrail.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stadlerrail.com/job/456')).toBe(true);
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
      expect(slugify('Developer stadler-rail ch')).toBe('developer-stadler-rail-ch');
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
      id: 'stadler-rail-abc123',
      slug: 'test-position-stadler-rail-ch',
      slugByLocale: { de: 'test-position-stadler-rail-ch' },
      company: 'Stadler Rail',
      companyKey: 'stadler-rail',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stadlerrail.com/jobs/test',
      source: 'Stadler Rail Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stadler-rail-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
