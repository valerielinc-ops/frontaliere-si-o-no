import { describe, it, expect } from 'vitest';
import {
  GALDERMA_KEY,
  GALDERMA_COMPANY_NAME,
  isGaldermaJob,
  isTrustedDomain,
} from '../scripts/lib/galderma-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Galderma crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GALDERMA_KEY).toBe('galderma');
    expect(GALDERMA_COMPANY_NAME).toBe('Galderma');
  });

  // ── isCompanyJob ──
  describe('isGaldermaJob', () => {
    it('matches by companyKey', () => {
      expect(isGaldermaJob({ companyKey: 'galderma' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGaldermaJob({ company: 'Galderma' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGaldermaJob({ url: 'https://galderma.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGaldermaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGaldermaJob(null)).toBe(false);
      expect(isGaldermaJob(undefined)).toBe(false);
      expect(isGaldermaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://galderma.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.galderma.com/job/456')).toBe(true);
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
      expect(slugify('Developer galderma ch')).toBe('developer-galderma-ch');
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
      id: 'galderma-abc123',
      slug: 'test-position-galderma-ch',
      slugByLocale: { en: 'test-position-galderma-ch' },
      company: 'Galderma',
      companyKey: 'galderma',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://galderma.com/jobs/test',
      source: 'Galderma Dedicated Parser',
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
      expect(validJob.id).toMatch(/^galderma-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
