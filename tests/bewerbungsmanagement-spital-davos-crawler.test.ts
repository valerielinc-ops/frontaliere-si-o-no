import { describe, it, expect } from 'vitest';
import {
  BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_KEY,
  BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_COMPANY_NAME,
  isBewerbungsmanagementSpitalDavosJob,
  isTrustedDomain,
} from '../scripts/lib/bewerbungsmanagement-spital-davos-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Bewerbungsmanagement Spital Davos crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_KEY).toBe('bewerbungsmanagement-spital-davos');
    expect(BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_COMPANY_NAME).toBe('Bewerbungsmanagement Spital Davos');
  });

  // ── isCompanyJob ──
  describe('isBewerbungsmanagementSpitalDavosJob', () => {
    it('matches by companyKey', () => {
      expect(isBewerbungsmanagementSpitalDavosJob({ companyKey: 'bewerbungsmanagement-spital-davos' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBewerbungsmanagementSpitalDavosJob({ company: 'Bewerbungsmanagement Spital Davos' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBewerbungsmanagementSpitalDavosJob({ url: 'https://recruitingapp-2966.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBewerbungsmanagementSpitalDavosJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBewerbungsmanagementSpitalDavosJob(null)).toBe(false);
      expect(isBewerbungsmanagementSpitalDavosJob(undefined)).toBe(false);
      expect(isBewerbungsmanagementSpitalDavosJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2966.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2966.umantis.com/job/456')).toBe(true);
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
      expect(slugify('Developer bewerbungsmanagement-spital-davos ch')).toBe('developer-bewerbungsmanagement-spital-davos-ch');
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
      id: 'bewerbungsmanagement-spital-davos-abc123',
      slug: 'test-position-bewerbungsmanagement-spital-davos-ch',
      slugByLocale: { de: 'test-position-bewerbungsmanagement-spital-davos-ch' },
      company: 'Bewerbungsmanagement Spital Davos',
      companyKey: 'bewerbungsmanagement-spital-davos',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2966.umantis.com/jobs/test',
      source: 'Bewerbungsmanagement Spital Davos Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bewerbungsmanagement-spital-davos-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
