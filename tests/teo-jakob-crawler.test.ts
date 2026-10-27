import { describe, it, expect } from 'vitest';
import {
  TEO_JAKOB_KEY,
  TEO_JAKOB_COMPANY_NAME,
  isTeoJakobJob,
  isTrustedDomain,
} from '../scripts/lib/teo-jakob-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Einrichtung & Innenarchitektur – Designberatung | teo jakob crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TEO_JAKOB_KEY).toBe('teo-jakob');
    expect(TEO_JAKOB_COMPANY_NAME).toBe('Einrichtung & Innenarchitektur – Designberatung | teo jakob');
  });

  // ── isCompanyJob ──
  describe('isTeoJakobJob', () => {
    it('matches by companyKey', () => {
      expect(isTeoJakobJob({ companyKey: 'teo-jakob' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTeoJakobJob({ company: 'Einrichtung & Innenarchitektur – Designberatung | teo jakob' })).toBe(true);
    });

    it('matches by source vacancy URL', () => {
      expect(isTeoJakobJob({
        url: 'https://my.jobalino.ch/public/job/607e9bf886583eaee25ea4db60baad92/teo-jakob-ag/mitarbeiter-fuer-auslieferung-und-montage-100',
      })).toBe(true);
    });

    it('rejects unrelated vacancies on the shared source host', () => {
      expect(isTeoJakobJob({
        companyKey: 'other',
        company: 'Other',
        url: 'https://my.jobalino.ch/public/job/other',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isTeoJakobJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTeoJakobJob(null)).toBe(false);
      expect(isTeoJakobJob(undefined)).toBe(false);
      expect(isTeoJakobJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://my.jobalino.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.my.jobalino.ch/job/456')).toBe(true);
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
      expect(slugify('Developer teo-jakob ch')).toBe('developer-teo-jakob-ch');
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
      id: 'teo-jakob-abc123',
      slug: 'test-position-teo-jakob-ch',
      slugByLocale: { de: 'test-position-teo-jakob-ch' },
      company: 'Einrichtung & Innenarchitektur – Designberatung | teo jakob',
      companyKey: 'teo-jakob',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://my.jobalino.ch/jobs/test',
      source: 'Einrichtung & Innenarchitektur – Designberatung | teo jakob Dedicated Parser',
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
      expect(validJob.id).toMatch(/^teo-jakob-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
