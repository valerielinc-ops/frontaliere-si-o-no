import { describe, it, expect } from 'vitest';
import {
  VAXCYTE_KEY,
  VAXCYTE_COMPANY_NAME,
  isVaxcyteJob,
  isTrustedDomain,
} from '../scripts/lib/vaxcyte-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Vaxcyte crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VAXCYTE_KEY).toBe('vaxcyte');
    expect(VAXCYTE_COMPANY_NAME).toBe('Vaxcyte');
  });

  // ── isCompanyJob ──
  describe('isVaxcyteJob', () => {
    it('matches by companyKey', () => {
      expect(isVaxcyteJob({ companyKey: 'vaxcyte' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVaxcyteJob({ company: 'Vaxcyte' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVaxcyteJob({ url: 'https://vaxcyte.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVaxcyteJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVaxcyteJob(null)).toBe(false);
      expect(isVaxcyteJob(undefined)).toBe(false);
      expect(isVaxcyteJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vaxcyte.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vaxcyte.com/job/456')).toBe(true);
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
      expect(slugify('Developer vaxcyte ch')).toBe('developer-vaxcyte-ch');
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
      id: 'vaxcyte-abc123',
      slug: 'test-position-vaxcyte-ch',
      slugByLocale: { en: 'test-position-vaxcyte-ch' },
      company: 'Vaxcyte',
      companyKey: 'vaxcyte',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vaxcyte.com/jobs/test',
      source: 'Vaxcyte Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vaxcyte-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
