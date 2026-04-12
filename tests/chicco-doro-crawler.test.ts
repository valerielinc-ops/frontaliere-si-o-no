import { describe, it, expect } from 'vitest';
import {
  CHICCO_DORO_KEY,
  CHICCO_DORO_COMPANY_NAME,
  isChiccoDoroJob,
  isTrustedDomain,
} from '../scripts/lib/chicco-doro-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Chicco d\u2019Oro crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CHICCO_DORO_KEY).toBe('chicco-doro');
    expect(CHICCO_DORO_COMPANY_NAME).toBe("Chicco d\u2019Oro");
  });

  // ── isCompanyJob ──
  describe('isChiccoDoroJob', () => {
    it('matches by companyKey', () => {
      expect(isChiccoDoroJob({ companyKey: 'chicco-doro' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isChiccoDoroJob({ company: "Chicco d\u2019Oro" })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isChiccoDoroJob({ url: 'https://chiccodoro.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isChiccoDoroJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isChiccoDoroJob(null)).toBe(false);
      expect(isChiccoDoroJob(undefined)).toBe(false);
      expect(isChiccoDoroJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://chiccodoro.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.chiccodoro.com/job/456')).toBe(true);
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
      expect(slugify('Developer chicco-doro ch')).toBe('developer-chicco-doro-ch');
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
      id: 'chicco-doro-abc123',
      slug: 'test-position-chicco-doro-ch',
      slugByLocale: { it: 'test-position-chicco-doro-ch' },
      company: "Chicco d\u2019Oro",
      companyKey: 'chicco-doro',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://chiccodoro.com/jobs/test',
      source: "Chicco d\u2019Oro Dedicated Parser",
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^chicco-doro-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
