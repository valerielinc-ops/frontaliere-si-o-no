import { describe, it, expect } from 'vitest';
import {
  DECATHLON_KEY,
  DECATHLON_COMPANY_NAME,
  isDecathlonJob,
  isTrustedDomain,
} from '../scripts/lib/decathlon-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Decathlon crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DECATHLON_KEY).toBe('decathlon');
    expect(DECATHLON_COMPANY_NAME).toBe('Decathlon');
  });

  // ── isCompanyJob ──
  describe('isDecathlonJob', () => {
    it('matches by companyKey', () => {
      expect(isDecathlonJob({ companyKey: 'decathlon' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDecathlonJob({ company: 'Decathlon' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDecathlonJob({ url: 'https://decathlon.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDecathlonJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDecathlonJob(null)).toBe(false);
      expect(isDecathlonJob(undefined)).toBe(false);
      expect(isDecathlonJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://decathlon.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.decathlon.ch/job/456')).toBe(true);
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
      expect(slugify('Developer decathlon ch')).toBe('developer-decathlon-ch');
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
      id: 'decathlon-abc123',
      slug: 'test-position-decathlon-ch',
      slugByLocale: { fr: 'test-position-decathlon-ch' },
      company: 'Decathlon',
      companyKey: 'decathlon',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://decathlon.ch/jobs/test',
      source: 'Decathlon Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^decathlon-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
