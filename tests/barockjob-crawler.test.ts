import { describe, it, expect } from 'vitest';
import {
  BAROCKJOB_KEY,
  BAROCKJOB_COMPANY_NAME,
  isBarockjobJob,
  isTrustedDomain,
} from '../scripts/lib/barockjob-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Barock Job AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BAROCKJOB_KEY).toBe('barockjob');
    expect(BAROCKJOB_COMPANY_NAME).toBe('Barock Job AG');
  });

  // ── isCompanyJob ──
  describe('isBarockjobJob', () => {
    it('matches by companyKey', () => {
      expect(isBarockjobJob({ companyKey: 'barockjob' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBarockjobJob({ company: 'Barock Job AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBarockjobJob({ url: 'https://barockjob.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBarockjobJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBarockjobJob(null)).toBe(false);
      expect(isBarockjobJob(undefined)).toBe(false);
      expect(isBarockjobJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://barockjob.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.barockjob.ch/job/456')).toBe(true);
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
      expect(slugify('Developer barockjob ch')).toBe('developer-barockjob-ch');
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
      id: 'barockjob-abc123',
      slug: 'test-position-barockjob-ch',
      slugByLocale: { de: 'test-position-barockjob-ch' },
      company: 'Barock Job AG',
      companyKey: 'barockjob',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://barockjob.ch/jobs/test',
      source: 'Barock Job AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^barockjob-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
