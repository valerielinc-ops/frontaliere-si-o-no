import { describe, it, expect } from 'vitest';
import {
  HEINI_CH_HEINI_CH_KEY,
  HEINI_CH_HEINI_CH_COMPANY_NAME,
  isHeiniChHeiniChJob,
  isTrustedDomain,
} from '../scripts/lib/heini-ch-heini-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Heini Conditorei AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HEINI_CH_HEINI_CH_KEY).toBe('heini-ch-heini-ch');
    expect(HEINI_CH_HEINI_CH_COMPANY_NAME).toBe('Heini Conditorei AG');
  });

  // ── isCompanyJob ──
  describe('isHeiniChHeiniChJob', () => {
    it('matches by companyKey', () => {
      expect(isHeiniChHeiniChJob({ companyKey: 'heini-ch-heini-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHeiniChHeiniChJob({ company: 'Heini Conditorei AG' })).toBe(true);
    });

    it('matches by employer-specific Yousty vacancy path', () => {
      expect(isHeiniChHeiniChJob({
        companyKey: 'other',
        company: 'Other',
        url: 'https://www.yousty.ch/de-CH/lehrstellen/profile/123-baecker-in-konditor-in-efz-heini-conditorei-ag',
      })).toBe(true);
    });

    it('rejects unrelated jobs on shared ATS hosts', () => {
      expect(isHeiniChHeiniChJob({
        companyKey: 'other',
        company: 'Other',
        url: 'https://www.yousty.ch/de-CH/lehrstellen/profile/other-employer-role',
      })).toBe(false);
      expect(isHeiniChHeiniChJob({
        companyKey: 'other',
        company: 'Other',
        url: 'https://link.ostendis.com/publication/other-employer-role/id',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isHeiniChHeiniChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHeiniChHeiniChJob(null)).toBe(false);
      expect(isHeiniChHeiniChJob(undefined)).toBe(false);
      expect(isHeiniChHeiniChJob({})).toBe(false);
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
      expect(slugify('Developer heini-ch-heini-ch ch')).toBe('developer-heini-ch-heini-ch-ch');
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
      id: 'heini-ch-heini-ch-abc123',
      slug: 'test-position-heini-ch-heini-ch-ch',
      slugByLocale: { de: 'test-position-heini-ch-heini-ch-ch' },
      company: 'Heini Conditorei AG',
      companyKey: 'heini-ch-heini-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://yousty.ch/jobs/test',
      source: 'Heini Conditorei AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^heini-ch-heini-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
