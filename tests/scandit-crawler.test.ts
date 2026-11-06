import { describe, it, expect } from 'vitest';
import {
  SCANDIT_KEY,
  SCANDIT_COMPANY_NAME,
  isScanditJob,
  isTrustedDomain,
} from '../scripts/lib/scandit-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Scandit AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SCANDIT_KEY).toBe('scandit');
    expect(SCANDIT_COMPANY_NAME).toBe('Scandit AG');
  });

  // ── isCompanyJob ──
  describe('isScanditJob', () => {
    it('matches by companyKey', () => {
      expect(isScanditJob({ companyKey: 'scandit' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isScanditJob({ company: 'Scandit AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isScanditJob({ url: 'https://scandit.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isScanditJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isScanditJob(null)).toBe(false);
      expect(isScanditJob(undefined)).toBe(false);
      expect(isScanditJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://scandit.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.scandit.com/job/456')).toBe(true);
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
      expect(slugify('Developer scandit ch')).toBe('developer-scandit-ch');
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
      id: 'scandit-abc123',
      slug: 'test-position-scandit-ch',
      slugByLocale: { en: 'test-position-scandit-ch' },
      company: 'Scandit AG',
      companyKey: 'scandit',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://scandit.com/jobs/test',
      source: 'Scandit AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^scandit-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
