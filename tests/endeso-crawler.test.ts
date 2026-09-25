import { describe, it, expect } from 'vitest';
import {
  ENDESO_KEY,
  ENDESO_COMPANY_NAME,
  isEndesoJob,
  isTrustedDomain,
} from '../scripts/lib/endeso-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('endeso GmbH crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ENDESO_KEY).toBe('endeso');
    expect(ENDESO_COMPANY_NAME).toBe('endeso GmbH');
  });

  // ── isCompanyJob ──
  describe('isEndesoJob', () => {
    it('matches by companyKey', () => {
      expect(isEndesoJob({ companyKey: 'endeso' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEndesoJob({ company: 'endeso GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEndesoJob({ url: 'https://endeso.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEndesoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEndesoJob(null)).toBe(false);
      expect(isEndesoJob(undefined)).toBe(false);
      expect(isEndesoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://endeso.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.endeso.ch/job/456')).toBe(true);
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
      expect(slugify('Developer endeso ch')).toBe('developer-endeso-ch');
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
      id: 'endeso-abc123',
      slug: 'test-position-endeso-ch',
      slugByLocale: { de: 'test-position-endeso-ch' },
      company: 'endeso GmbH',
      companyKey: 'endeso',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://endeso.ch/jobs/test',
      source: 'endeso GmbH Dedicated Parser',
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
      expect(validJob.id).toMatch(/^endeso-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
