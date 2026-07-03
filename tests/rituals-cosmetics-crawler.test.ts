import { describe, it, expect } from 'vitest';
import {
  RITUALS_COSMETICS_KEY,
  RITUALS_COSMETICS_COMPANY_NAME,
  isRitualsCosmeticsJob,
  isTrustedDomain,
} from '../scripts/lib/rituals-cosmetics-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Rituals Cosmetics Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RITUALS_COSMETICS_KEY).toBe('rituals-cosmetics');
    expect(RITUALS_COSMETICS_COMPANY_NAME).toBe('Rituals Cosmetics Switzerland');
  });

  // ── isCompanyJob ──
  describe('isRitualsCosmeticsJob', () => {
    it('matches by companyKey', () => {
      expect(isRitualsCosmeticsJob({ companyKey: 'rituals-cosmetics' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRitualsCosmeticsJob({ company: 'Rituals Cosmetics Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRitualsCosmeticsJob({ url: 'https://rituals.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRitualsCosmeticsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRitualsCosmeticsJob(null)).toBe(false);
      expect(isRitualsCosmeticsJob(undefined)).toBe(false);
      expect(isRitualsCosmeticsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://rituals.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.rituals.com/job/456')).toBe(true);
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
      expect(slugify('Developer rituals-cosmetics ch')).toBe('developer-rituals-cosmetics-ch');
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
      id: 'rituals-cosmetics-abc123',
      slug: 'test-position-rituals-cosmetics-ch',
      slugByLocale: { de: 'test-position-rituals-cosmetics-ch' },
      company: 'Rituals Cosmetics Switzerland',
      companyKey: 'rituals-cosmetics',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://rituals.com/jobs/test',
      source: 'Rituals Cosmetics Switzerland Dedicated Parser',
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
      expect(validJob.id).toMatch(/^rituals-cosmetics-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
