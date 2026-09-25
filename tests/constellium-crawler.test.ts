import { describe, it, expect } from 'vitest';
import {
  CONSTELLIUM_KEY,
  CONSTELLIUM_COMPANY_NAME,
  isConstelliumJob,
  isTrustedDomain,
} from '../scripts/lib/constellium-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Constellium Valais crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CONSTELLIUM_KEY).toBe('constellium');
    expect(CONSTELLIUM_COMPANY_NAME).toBe('Constellium Valais');
  });

  // ── isCompanyJob ──
  describe('isConstelliumJob', () => {
    it('matches by companyKey', () => {
      expect(isConstelliumJob({ companyKey: 'constellium' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isConstelliumJob({ company: 'Constellium Valais' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isConstelliumJob({ url: 'https://constellium.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isConstelliumJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isConstelliumJob(null)).toBe(false);
      expect(isConstelliumJob(undefined)).toBe(false);
      expect(isConstelliumJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://constellium.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.constellium.com/job/456')).toBe(true);
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
      expect(slugify('Developer constellium ch')).toBe('developer-constellium-ch');
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
      id: 'constellium-abc123',
      slug: 'test-position-constellium-ch',
      slugByLocale: { fr: 'test-position-constellium-ch' },
      company: 'Constellium Valais',
      companyKey: 'constellium',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://constellium.com/jobs/test',
      source: 'Constellium Valais Dedicated Parser',
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
      expect(validJob.id).toMatch(/^constellium-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
