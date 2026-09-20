import { describe, it, expect } from 'vitest';
import {
  IM_BETHESDA_SPITAL_KEY,
  IM_BETHESDA_SPITAL_COMPANY_NAME,
  isImBethesdaSpitalJob,
  isTrustedDomain,
} from '../scripts/lib/im-bethesda-spital-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('& im Bethesda Spital crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IM_BETHESDA_SPITAL_KEY).toBe('im-bethesda-spital');
    expect(IM_BETHESDA_SPITAL_COMPANY_NAME).toBe('& im Bethesda Spital');
  });

  // ── isCompanyJob ──
  describe('isImBethesdaSpitalJob', () => {
    it('matches by companyKey', () => {
      expect(isImBethesdaSpitalJob({ companyKey: 'im-bethesda-spital' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isImBethesdaSpitalJob({ company: '& im Bethesda Spital' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isImBethesdaSpitalJob({ url: 'https://bethesda-spital.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isImBethesdaSpitalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isImBethesdaSpitalJob(null)).toBe(false);
      expect(isImBethesdaSpitalJob(undefined)).toBe(false);
      expect(isImBethesdaSpitalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bethesda-spital.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bethesda-spital.ch/job/456')).toBe(true);
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
      expect(slugify('Developer im-bethesda-spital ch')).toBe('developer-im-bethesda-spital-ch');
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
      id: 'im-bethesda-spital-abc123',
      slug: 'test-position-im-bethesda-spital-ch',
      slugByLocale: { de: 'test-position-im-bethesda-spital-ch' },
      company: '& im Bethesda Spital',
      companyKey: 'im-bethesda-spital',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bethesda-spital.ch/jobs/test',
      source: '& im Bethesda Spital Dedicated Parser',
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
      expect(validJob.id).toMatch(/^im-bethesda-spital-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
