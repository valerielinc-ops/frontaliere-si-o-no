import { describe, it, expect } from 'vitest';
import {
  STADTSPITAL_ZUERICH_KEY,
  STADTSPITAL_ZUERICH_COMPANY_NAME,
  isStadtspitalZuerichJob,
  isTrustedDomain,
} from '../scripts/lib/stadtspital-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stadtspital Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADTSPITAL_ZUERICH_KEY).toBe('stadtspital-zuerich');
    expect(STADTSPITAL_ZUERICH_COMPANY_NAME).toBe('Stadtspital Zürich');
  });

  // ── isCompanyJob ──
  describe('isStadtspitalZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'stadtspital-zuerich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtspitalZuerichJob({ company: 'Stadtspital Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStadtspitalZuerichJob({ url: 'https://stadtspital.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtspitalZuerichJob(null)).toBe(false);
      expect(isStadtspitalZuerichJob(undefined)).toBe(false);
      expect(isStadtspitalZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stadtspital.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stadtspital.ch/job/456')).toBe(true);
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
      expect(slugify('Developer stadtspital-zuerich ch')).toBe('developer-stadtspital-zuerich-ch');
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
      id: 'stadtspital-zuerich-abc123',
      slug: 'test-position-stadtspital-zuerich-ch',
      slugByLocale: { de: 'test-position-stadtspital-zuerich-ch' },
      company: 'Stadtspital Zürich',
      companyKey: 'stadtspital-zuerich',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stadtspital.ch/jobs/test',
      source: 'Stadtspital Zürich Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stadtspital-zuerich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
