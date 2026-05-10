import { describe, it, expect } from 'vitest';
import {
  KSSG_KEY,
  KSSG_COMPANY_NAME,
  isKssgJob,
  isTrustedDomain,
} from '../scripts/lib/kssg-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kantonsspital St. Gallen (KSSG / HOCH) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KSSG_KEY).toBe('kssg');
    expect(KSSG_COMPANY_NAME).toBe('Kantonsspital St. Gallen (KSSG / HOCH)');
  });

  // ── isCompanyJob ──
  describe('isKssgJob', () => {
    it('matches by companyKey', () => {
      expect(isKssgJob({ companyKey: 'kssg' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKssgJob({ company: 'Kantonsspital St. Gallen (KSSG / HOCH)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKssgJob({ url: 'https://kssg.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKssgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKssgJob(null)).toBe(false);
      expect(isKssgJob(undefined)).toBe(false);
      expect(isKssgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kssg.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.kssg.ch/job/456')).toBe(true);
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
      expect(slugify('Developer kssg ch')).toBe('developer-kssg-ch');
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
      id: 'kssg-abc123',
      slug: 'test-position-kssg-ch',
      slugByLocale: { de: 'test-position-kssg-ch' },
      company: 'Kantonsspital St. Gallen (KSSG / HOCH)',
      companyKey: 'kssg',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://kssg.ch/jobs/test',
      source: 'Kantonsspital St. Gallen (KSSG / HOCH) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kssg-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
