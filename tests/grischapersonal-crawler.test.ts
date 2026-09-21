import { describe, it, expect } from 'vitest';
import {
  GRISCHAPERSONAL_KEY,
  GRISCHAPERSONAL_COMPANY_NAME,
  isGrischapersonalJob,
  isTrustedDomain,
} from '../scripts/lib/grischapersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Grischa Personal AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GRISCHAPERSONAL_KEY).toBe('grischapersonal');
    expect(GRISCHAPERSONAL_COMPANY_NAME).toBe('Grischa Personal AG');
  });

  // ── isCompanyJob ──
  describe('isGrischapersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isGrischapersonalJob({ companyKey: 'grischapersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGrischapersonalJob({ company: 'Grischa Personal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGrischapersonalJob({ url: 'https://grischapersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGrischapersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGrischapersonalJob(null)).toBe(false);
      expect(isGrischapersonalJob(undefined)).toBe(false);
      expect(isGrischapersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://grischapersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.grischapersonal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer grischapersonal ch')).toBe('developer-grischapersonal-ch');
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
      id: 'grischapersonal-abc123',
      slug: 'test-position-grischapersonal-ch',
      slugByLocale: { de: 'test-position-grischapersonal-ch' },
      company: 'Grischa Personal AG',
      companyKey: 'grischapersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://grischapersonal.ch/jobs/test',
      source: 'Grischa Personal AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^grischapersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
