import { describe, it, expect } from 'vitest';
import {
  CAREERS_KEY,
  CAREERS_COMPANY_NAME,
  isCareersJob,
  isTrustedDomain,
} from '../scripts/lib/careers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('lepatron crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CAREERS_KEY).toBe('careers');
    expect(CAREERS_COMPANY_NAME).toBe('lepatron');
  });

  // ── isCompanyJob ──
  describe('isCareersJob', () => {
    it('matches by companyKey', () => {
      expect(isCareersJob({ companyKey: 'careers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCareersJob({ company: 'lepatron' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCareersJob({ url: 'https://careers.orior.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCareersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCareersJob(null)).toBe(false);
      expect(isCareersJob(undefined)).toBe(false);
      expect(isCareersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://careers.orior.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.careers.orior.ch/job/456')).toBe(true);
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
      expect(slugify('Developer careers ch')).toBe('developer-careers-ch');
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
      id: 'careers-abc123',
      slug: 'test-position-careers-ch',
      slugByLocale: { de: 'test-position-careers-ch' },
      company: 'lepatron',
      companyKey: 'careers',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://careers.orior.ch/jobs/test',
      source: 'lepatron Dedicated Parser',
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
      expect(validJob.id).toMatch(/^careers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
