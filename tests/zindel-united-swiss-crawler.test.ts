import { describe, it, expect } from 'vitest';
import {
  ZINDEL_UNITED_SWISS_KEY,
  ZINDEL_UNITED_SWISS_COMPANY_NAME,
  isZindelUnitedSwissJob,
  isTrustedDomain,
} from '../scripts/lib/zindel-united-swiss-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Zindel + Co. AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZINDEL_UNITED_SWISS_KEY).toBe('zindel-united-swiss');
    expect(ZINDEL_UNITED_SWISS_COMPANY_NAME).toBe('Zindel + Co. AG');
  });

  // ── isCompanyJob ──
  describe('isZindelUnitedSwissJob', () => {
    it('matches by companyKey', () => {
      expect(isZindelUnitedSwissJob({ companyKey: 'zindel-united-swiss' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZindelUnitedSwissJob({ company: 'Zindel + Co. AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isZindelUnitedSwissJob({ url: 'https://zindel-united.swiss/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZindelUnitedSwissJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZindelUnitedSwissJob(null)).toBe(false);
      expect(isZindelUnitedSwissJob(undefined)).toBe(false);
      expect(isZindelUnitedSwissJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://zindel-united.swiss/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.zindel-united.swiss/job/456')).toBe(true);
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
      expect(slugify('Developer zindel-united-swiss ch')).toBe('developer-zindel-united-swiss-ch');
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
      id: 'zindel-united-swiss-abc123',
      slug: 'test-position-zindel-united-swiss-ch',
      slugByLocale: { de: 'test-position-zindel-united-swiss-ch' },
      company: 'Zindel + Co. AG',
      companyKey: 'zindel-united-swiss',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://zindel-united.swiss/jobs/test',
      source: 'Zindel + Co. AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^zindel-united-swiss-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
