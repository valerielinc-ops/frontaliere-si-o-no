import { describe, it, expect } from 'vitest';
import {
  FRANKLIN_UNIVERSITY_KEY,
  FRANKLIN_UNIVERSITY_COMPANY_NAME,
  isFranklinUniversityJob,
  isTrustedDomain,
} from '../scripts/lib/franklin-university-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Franklin University Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FRANKLIN_UNIVERSITY_KEY).toBe('franklin-university');
    expect(FRANKLIN_UNIVERSITY_COMPANY_NAME).toBe('Franklin University Switzerland');
  });

  // ── isCompanyJob ──
  describe('isFranklinUniversityJob', () => {
    it('matches by companyKey', () => {
      expect(isFranklinUniversityJob({ companyKey: 'franklin-university' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFranklinUniversityJob({ company: 'Franklin University Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFranklinUniversityJob({ url: 'https://franklin.edu.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFranklinUniversityJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFranklinUniversityJob(null)).toBe(false);
      expect(isFranklinUniversityJob(undefined)).toBe(false);
      expect(isFranklinUniversityJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://franklin.edu.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.franklin.edu.ch/job/456')).toBe(true);
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
      expect(slugify('Developer franklin-university ch')).toBe('developer-franklin-university-ch');
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
      id: 'franklin-university-abc123',
      slug: 'test-position-franklin-university-ch',
      slugByLocale: { en: 'test-position-franklin-university-ch' },
      company: 'Franklin University Switzerland',
      companyKey: 'franklin-university',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://franklin.edu.ch/jobs/test',
      source: 'Franklin University Switzerland Dedicated Parser',
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
      expect(validJob.id).toMatch(/^franklin-university-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
