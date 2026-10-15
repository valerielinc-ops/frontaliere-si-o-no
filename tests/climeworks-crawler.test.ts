import { describe, it, expect } from 'vitest';
import {
  CLIMEWORKS_KEY,
  CLIMEWORKS_COMPANY_NAME,
  isClimeworksJob,
  isTrustedDomain,
} from '../scripts/lib/climeworks-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Climeworks crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLIMEWORKS_KEY).toBe('climeworks');
    expect(CLIMEWORKS_COMPANY_NAME).toBe('Climeworks');
  });

  // ── isCompanyJob ──
  describe('isClimeworksJob', () => {
    it('matches by companyKey', () => {
      expect(isClimeworksJob({ companyKey: 'climeworks' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isClimeworksJob({ company: 'Climeworks' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isClimeworksJob({ url: 'https://climeworks.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isClimeworksJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isClimeworksJob(null)).toBe(false);
      expect(isClimeworksJob(undefined)).toBe(false);
      expect(isClimeworksJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://climeworks.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.climeworks.com/job/456')).toBe(true);
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
      expect(slugify('Developer climeworks ch')).toBe('developer-climeworks-ch');
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
      id: 'climeworks-abc123',
      slug: 'test-position-climeworks-ch',
      slugByLocale: { en: 'test-position-climeworks-ch' },
      company: 'Climeworks',
      companyKey: 'climeworks',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://climeworks.com/jobs/test',
      source: 'Climeworks Dedicated Parser',
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
      expect(validJob.id).toMatch(/^climeworks-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
