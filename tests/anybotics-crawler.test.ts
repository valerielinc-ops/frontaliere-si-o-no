import { describe, it, expect } from 'vitest';
import {
  ANYBOTICS_KEY,
  ANYBOTICS_COMPANY_NAME,
  isAnyboticsJob,
  isTrustedDomain,
} from '../scripts/lib/anybotics-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ANYbotics crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ANYBOTICS_KEY).toBe('anybotics');
    expect(ANYBOTICS_COMPANY_NAME).toBe('ANYbotics');
  });

  // ── isCompanyJob ──
  describe('isAnyboticsJob', () => {
    it('matches by companyKey', () => {
      expect(isAnyboticsJob({ companyKey: 'anybotics' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAnyboticsJob({ company: 'ANYbotics' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAnyboticsJob({ url: 'https://anybotics.com/jobs/123' })).toBe(true);
    });

    it('matches by Lever posting-board URL', () => {
      expect(isAnyboticsJob({ url: 'https://jobs.lever.co/anybotics/abc-123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAnyboticsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAnyboticsJob(null)).toBe(false);
      expect(isAnyboticsJob(undefined)).toBe(false);
      expect(isAnyboticsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://anybotics.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.anybotics.com/job/456')).toBe(true);
    });

    it('trusts the ANYbotics Lever posting board (real apply-URL host)', () => {
      expect(isTrustedDomain('https://jobs.lever.co/anybotics/abc-123-def-456')).toBe(true);
    });

    it('rejects other companies on Lever', () => {
      expect(isTrustedDomain('https://jobs.lever.co/other-company/abc-123')).toBe(false);
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
      expect(slugify('Developer anybotics ch')).toBe('developer-anybotics-ch');
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
      id: 'anybotics-abc123',
      slug: 'test-position-anybotics-ch',
      slugByLocale: { en: 'test-position-anybotics-ch' },
      company: 'ANYbotics',
      companyKey: 'anybotics',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zurich, Switzerland',
      canton: 'ZH',
      url: 'https://jobs.lever.co/anybotics/abc-123-def-456',
      source: 'ANYbotics Dedicated Parser',
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
      expect(validJob.id).toMatch(/^anybotics-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
