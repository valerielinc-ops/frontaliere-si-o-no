import { describe, it, expect } from 'vitest';
import {
  INTERDISCOUNT_KEY,
  INTERDISCOUNT_COMPANY_NAME,
  isInterdiscountJob,
  isTrustedDomain,
} from '../scripts/lib/interdiscount-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Interdiscount crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(INTERDISCOUNT_KEY).toBe('interdiscount');
    expect(INTERDISCOUNT_COMPANY_NAME).toBe('Interdiscount');
  });

  // ── isCompanyJob ──
  describe('isInterdiscountJob', () => {
    it('matches by companyKey', () => {
      expect(isInterdiscountJob({ companyKey: 'interdiscount' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isInterdiscountJob({ company: 'Interdiscount' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isInterdiscountJob({ url: 'https://jobs.interdiscount.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isInterdiscountJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isInterdiscountJob(null)).toBe(false);
      expect(isInterdiscountJob(undefined)).toBe(false);
      expect(isInterdiscountJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.interdiscount.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.interdiscount.ch/job/456')).toBe(true);
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
      expect(slugify('Developer interdiscount ch')).toBe('developer-interdiscount-ch');
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
      id: 'interdiscount-abc123',
      slug: 'test-position-interdiscount-ch',
      slugByLocale: { de: 'test-position-interdiscount-ch' },
      company: 'Interdiscount',
      companyKey: 'interdiscount',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.interdiscount.ch/jobs/test',
      source: 'Interdiscount Dedicated Parser',
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
      expect(validJob.id).toMatch(/^interdiscount-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
