import { describe, it, expect } from 'vitest';
import {
  GLOBUS_KEY,
  GLOBUS_COMPANY_NAME,
  isGlobusJob,
  isTrustedDomain,
} from '../scripts/lib/globus-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Globus crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GLOBUS_KEY).toBe('globus');
    expect(GLOBUS_COMPANY_NAME).toBe('Globus');
  });

  // ── isCompanyJob ──
  describe('isGlobusJob', () => {
    it('matches by companyKey', () => {
      expect(isGlobusJob({ companyKey: 'globus' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGlobusJob({ company: 'Globus' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGlobusJob({ url: 'https://globus.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGlobusJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGlobusJob(null)).toBe(false);
      expect(isGlobusJob(undefined)).toBe(false);
      expect(isGlobusJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://globus.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.globus.ch/job/456')).toBe(true);
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
      expect(slugify('Developer globus ch')).toBe('developer-globus-ch');
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
      id: 'globus-abc123',
      slug: 'test-position-globus-ch',
      slugByLocale: { de: 'test-position-globus-ch' },
      company: 'Globus',
      companyKey: 'globus',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://globus.ch/jobs/test',
      source: 'Globus Dedicated Parser',
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
      expect(validJob.id).toMatch(/^globus-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
