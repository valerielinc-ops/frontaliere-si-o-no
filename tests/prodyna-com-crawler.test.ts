import { describe, it, expect } from 'vitest';
import {
  PRODYNA_COM_KEY,
  PRODYNA_COM_COMPANY_NAME,
  isProdynaComJob,
  isTrustedDomain,
} from '../scripts/lib/prodyna-com-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('PRODYNA (Schweiz) AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PRODYNA_COM_KEY).toBe('prodyna-com');
    expect(PRODYNA_COM_COMPANY_NAME).toBe('PRODYNA (Schweiz) AG');
  });

  // ── isCompanyJob ──
  describe('isProdynaComJob', () => {
    it('matches by companyKey', () => {
      expect(isProdynaComJob({ companyKey: 'prodyna-com' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isProdynaComJob({ company: 'PRODYNA (Schweiz) AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isProdynaComJob({ url: 'https://prodyna.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isProdynaComJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isProdynaComJob(null)).toBe(false);
      expect(isProdynaComJob(undefined)).toBe(false);
      expect(isProdynaComJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://prodyna.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.prodyna.com/job/456')).toBe(true);
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
      expect(slugify('Developer prodyna-com ch')).toBe('developer-prodyna-com-ch');
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
      id: 'prodyna-com-abc123',
      slug: 'test-position-prodyna-com-ch',
      slugByLocale: { en: 'test-position-prodyna-com-ch' },
      company: 'PRODYNA (Schweiz) AG',
      companyKey: 'prodyna-com',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://prodyna.com/jobs/test',
      source: 'PRODYNA (Schweiz) AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^prodyna-com-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
