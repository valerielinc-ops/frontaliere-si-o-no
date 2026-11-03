import { describe, it, expect } from 'vitest';
import {
  INVIAS_SWISS_KEY,
  INVIAS_SWISS_COMPANY_NAME,
  isInviasSwissJob,
  isTrustedDomain,
} from '../scripts/lib/invias-swiss-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Invias AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(INVIAS_SWISS_KEY).toBe('invias-swiss');
    expect(INVIAS_SWISS_COMPANY_NAME).toBe('Invias AG');
  });

  // ── isCompanyJob ──
  describe('isInviasSwissJob', () => {
    it('matches by companyKey', () => {
      expect(isInviasSwissJob({ companyKey: 'invias-swiss' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isInviasSwissJob({ company: 'Invias AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isInviasSwissJob({ url: 'https://invias.swiss/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isInviasSwissJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isInviasSwissJob(null)).toBe(false);
      expect(isInviasSwissJob(undefined)).toBe(false);
      expect(isInviasSwissJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://invias.swiss/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.invias.swiss/job/456')).toBe(true);
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
      expect(slugify('Developer invias-swiss ch')).toBe('developer-invias-swiss-ch');
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
      id: 'invias-swiss-abc123',
      slug: 'test-position-invias-swiss-ch',
      slugByLocale: { de: 'test-position-invias-swiss-ch' },
      company: 'Invias AG',
      companyKey: 'invias-swiss',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://invias.swiss/jobs/test',
      source: 'Invias AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^invias-swiss-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
