import { describe, it, expect } from 'vitest';
import {
  COGESTIM_CH_KEY,
  COGESTIM_CH_COMPANY_NAME,
  isCogestimChJob,
  isTrustedDomain,
} from '../scripts/lib/cogestim-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('COGESTIM SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(COGESTIM_CH_KEY).toBe('cogestim-ch');
    expect(COGESTIM_CH_COMPANY_NAME).toBe('COGESTIM SA');
  });

  // ── isCompanyJob ──
  describe('isCogestimChJob', () => {
    it('matches by companyKey', () => {
      expect(isCogestimChJob({ companyKey: 'cogestim-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCogestimChJob({ company: 'COGESTIM SA' })).toBe(true);
    });

    it('rejects lookalike company names', () => {
      expect(isCogestimChJob({ company: 'Not COGESTIM SA' })).toBe(false);
    });

    it('matches by URL domain', () => {
      expect(isCogestimChJob({ url: 'https://cogestim.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCogestimChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCogestimChJob(null)).toBe(false);
      expect(isCogestimChJob(undefined)).toBe(false);
      expect(isCogestimChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cogestim.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.cogestim.ch/job/456')).toBe(true);
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
      expect(slugify('Developer cogestim-ch ch')).toBe('developer-cogestim-ch-ch');
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
      id: 'cogestim-ch-abc123',
      slug: 'test-position-cogestim-ch-ch',
      slugByLocale: { fr: 'test-position-cogestim-ch-ch' },
      company: 'COGESTIM SA',
      companyKey: 'cogestim-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://cogestim.ch/jobs/test',
      source: 'COGESTIM SA Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^cogestim-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
