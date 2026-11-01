import { describe, it, expect } from 'vitest';
import {
  SINTIO_CH_KEY,
  SINTIO_CH_COMPANY_NAME,
  isSintioChJob,
  isTrustedDomain,
} from '../scripts/lib/sintio-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Sintio crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SINTIO_CH_KEY).toBe('sintio-ch');
    expect(SINTIO_CH_COMPANY_NAME).toBe('Sintio');
  });

  // ── isCompanyJob ──
  describe('isSintioChJob', () => {
    it('matches by companyKey', () => {
      expect(isSintioChJob({ companyKey: 'sintio-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSintioChJob({ company: 'Sintio' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSintioChJob({ url: 'https://join.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSintioChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSintioChJob(null)).toBe(false);
      expect(isSintioChJob(undefined)).toBe(false);
      expect(isSintioChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://join.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.join.com/job/456')).toBe(true);
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
      expect(slugify('Developer sintio-ch ch')).toBe('developer-sintio-ch-ch');
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
      id: 'sintio-ch-abc123',
      slug: 'test-position-sintio-ch-ch',
      slugByLocale: { en: 'test-position-sintio-ch-ch' },
      company: 'Sintio',
      companyKey: 'sintio-ch',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://join.com/jobs/test',
      source: 'Sintio Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^sintio-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
