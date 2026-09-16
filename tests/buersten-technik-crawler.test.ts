import { describe, it, expect } from 'vitest';
import {
  BUERSTEN_TECHNIK_KEY,
  BUERSTEN_TECHNIK_COMPANY_NAME,
  isBuerstenTechnikJob,
  isTrustedDomain,
} from '../scripts/lib/buersten-technik-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('buersten-technik crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BUERSTEN_TECHNIK_KEY).toBe('buersten-technik');
    expect(BUERSTEN_TECHNIK_COMPANY_NAME).toBe('buersten-technik');
  });

  // ── isCompanyJob ──
  describe('isBuerstenTechnikJob', () => {
    it('matches by companyKey', () => {
      expect(isBuerstenTechnikJob({ companyKey: 'buersten-technik' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBuerstenTechnikJob({ company: 'buersten-technik' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBuerstenTechnikJob({ url: 'https://yousty.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBuerstenTechnikJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBuerstenTechnikJob(null)).toBe(false);
      expect(isBuerstenTechnikJob(undefined)).toBe(false);
      expect(isBuerstenTechnikJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://yousty.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.yousty.ch/job/456')).toBe(true);
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
      expect(slugify('Developer buersten-technik ch')).toBe('developer-buersten-technik-ch');
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
      id: 'buersten-technik-abc123',
      slug: 'test-position-buersten-technik-ch',
      slugByLocale: { de: 'test-position-buersten-technik-ch' },
      company: 'buersten-technik',
      companyKey: 'buersten-technik',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://yousty.ch/jobs/test',
      source: 'buersten-technik Dedicated Parser',
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
      expect(validJob.id).toMatch(/^buersten-technik-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
