import { describe, it, expect } from 'vitest';
import {
  A2NAILS_CH_KEY,
  A2NAILS_CH_COMPANY_NAME,
  isA2nailsChJob,
  isTrustedDomain,
} from '../scripts/lib/a2nails-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('A2 Nails Nyon crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(A2NAILS_CH_KEY).toBe('a2nails-ch');
    expect(A2NAILS_CH_COMPANY_NAME).toBe('A2 Nails Nyon');
  });

  // ── isCompanyJob ──
  describe('isA2nailsChJob', () => {
    it('matches by companyKey', () => {
      expect(isA2nailsChJob({ companyKey: 'a2nails-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isA2nailsChJob({ company: 'A2 Nails Nyon' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isA2nailsChJob({ url: 'https://a2nails.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isA2nailsChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isA2nailsChJob(null)).toBe(false);
      expect(isA2nailsChJob(undefined)).toBe(false);
      expect(isA2nailsChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://a2nails.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.a2nails.ch/job/456')).toBe(true);
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
      expect(slugify('Developer a2nails-ch ch')).toBe('developer-a2nails-ch-ch');
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
      id: 'a2nails-ch-abc123',
      slug: 'test-position-a2nails-ch-ch',
      slugByLocale: { fr: 'test-position-a2nails-ch-ch' },
      company: 'A2 Nails Nyon',
      companyKey: 'a2nails-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://a2nails.ch/jobs/test',
      source: 'A2 Nails Nyon Dedicated Parser',
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
      expect(validJob.id).toMatch(/^a2nails-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
