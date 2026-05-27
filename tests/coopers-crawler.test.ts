import { describe, it, expect } from 'vitest';
import {
  COOPERS_KEY,
  COOPERS_COMPANY_NAME,
  isCoopersJob,
  isTrustedDomain,
} from '../scripts/lib/coopers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Coopers Group AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(COOPERS_KEY).toBe('coopers');
    expect(COOPERS_COMPANY_NAME).toBe('Coopers Group AG');
  });

  // ── isCompanyJob ──
  describe('isCoopersJob', () => {
    it('matches by companyKey', () => {
      expect(isCoopersJob({ companyKey: 'coopers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCoopersJob({ company: 'Coopers Group AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCoopersJob({ url: 'https://coopers.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCoopersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCoopersJob(null)).toBe(false);
      expect(isCoopersJob(undefined)).toBe(false);
      expect(isCoopersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://coopers.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.coopers.ch/job/456')).toBe(true);
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
      expect(slugify('Developer coopers ch')).toBe('developer-coopers-ch');
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
      id: 'coopers-abc123',
      slug: 'test-position-coopers-ch',
      slugByLocale: { en: 'test-position-coopers-ch' },
      company: 'Coopers Group AG',
      companyKey: 'coopers',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://coopers.ch/jobs/test',
      source: 'Coopers Group AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^coopers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
