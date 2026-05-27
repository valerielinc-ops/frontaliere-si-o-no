import { describe, it, expect } from 'vitest';
import {
  EPFL_KEY,
  EPFL_COMPANY_NAME,
  isEpflJob,
  isTrustedDomain,
} from '../scripts/lib/epfl-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('EPFL crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EPFL_KEY).toBe('epfl');
    expect(EPFL_COMPANY_NAME).toBe('EPFL');
  });

  // ── isCompanyJob ──
  describe('isEpflJob', () => {
    it('matches by companyKey', () => {
      expect(isEpflJob({ companyKey: 'epfl' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEpflJob({ company: 'EPFL' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEpflJob({ url: 'https://epfl.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEpflJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEpflJob(null)).toBe(false);
      expect(isEpflJob(undefined)).toBe(false);
      expect(isEpflJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://epfl.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.epfl.ch/job/456')).toBe(true);
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
      expect(slugify('Developer epfl ch')).toBe('developer-epfl-ch');
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
      id: 'epfl-abc123',
      slug: 'test-position-epfl-ch',
      slugByLocale: { it: 'test-position-epfl-ch' },
      company: 'EPFL',
      companyKey: 'epfl',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://epfl.ch/jobs/test',
      source: 'EPFL Dedicated Parser',
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
      expect(validJob.id).toMatch(/^epfl-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
