import { describe, it, expect } from 'vitest';
import {
  KELLERHALS_CARRARD_KEY,
  KELLERHALS_CARRARD_COMPANY_NAME,
  isKellerhalsCarrardJob,
  isTrustedDomain,
} from '../scripts/lib/kellerhals-carrard-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kellerhals Carrard crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KELLERHALS_CARRARD_KEY).toBe('kellerhals-carrard');
    expect(KELLERHALS_CARRARD_COMPANY_NAME).toBe('Kellerhals Carrard');
  });

  // ── isCompanyJob ──
  describe('isKellerhalsCarrardJob', () => {
    it('matches by companyKey', () => {
      expect(isKellerhalsCarrardJob({ companyKey: 'kellerhals-carrard' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKellerhalsCarrardJob({ company: 'Kellerhals Carrard' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKellerhalsCarrardJob({ url: 'https://kellerhals-carrard.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKellerhalsCarrardJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKellerhalsCarrardJob(null)).toBe(false);
      expect(isKellerhalsCarrardJob(undefined)).toBe(false);
      expect(isKellerhalsCarrardJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kellerhals-carrard.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.kellerhals-carrard.ch/job/456')).toBe(true);
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
      expect(slugify('Developer kellerhals-carrard ch')).toBe('developer-kellerhals-carrard-ch');
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
      id: 'kellerhals-carrard-abc123',
      slug: 'test-position-kellerhals-carrard-ch',
      slugByLocale: { de: 'test-position-kellerhals-carrard-ch' },
      company: 'Kellerhals Carrard',
      companyKey: 'kellerhals-carrard',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://kellerhals-carrard.ch/jobs/test',
      source: 'Kellerhals Carrard Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kellerhals-carrard-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
