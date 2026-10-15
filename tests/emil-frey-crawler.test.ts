import { describe, it, expect } from 'vitest';
import {
  EMIL_FREY_KEY,
  EMIL_FREY_COMPANY_NAME,
  isEmilFreyJob,
  isTrustedDomain,
} from '../scripts/lib/emil-frey-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Emil Frey crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EMIL_FREY_KEY).toBe('emil-frey');
    expect(EMIL_FREY_COMPANY_NAME).toBe('Emil Frey');
  });

  // ── isCompanyJob ──
  describe('isEmilFreyJob', () => {
    it('matches by companyKey', () => {
      expect(isEmilFreyJob({ companyKey: 'emil-frey' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEmilFreyJob({ company: 'Emil Frey' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEmilFreyJob({ url: 'https://emilfrey.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEmilFreyJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEmilFreyJob(null)).toBe(false);
      expect(isEmilFreyJob(undefined)).toBe(false);
      expect(isEmilFreyJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://emilfrey.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.emilfrey.ch/job/456')).toBe(true);
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
      expect(slugify('Developer emil-frey ch')).toBe('developer-emil-frey-ch');
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
      id: 'emil-frey-abc123',
      slug: 'test-position-emil-frey-ch',
      slugByLocale: { de: 'test-position-emil-frey-ch' },
      company: 'Emil Frey',
      companyKey: 'emil-frey',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://emilfrey.ch/jobs/test',
      source: 'Emil Frey Dedicated Parser',
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
      expect(validJob.id).toMatch(/^emil-frey-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
