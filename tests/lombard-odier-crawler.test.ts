import { describe, it, expect } from 'vitest';
import {
  LOMBARD_ODIER_KEY,
  LOMBARD_ODIER_COMPANY_NAME,
  isLombardOdierJob,
  isTrustedDomain,
} from '../scripts/lib/lombard-odier-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Lombard Odier crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LOMBARD_ODIER_KEY).toBe('lombard-odier');
    expect(LOMBARD_ODIER_COMPANY_NAME).toBe('Lombard Odier');
  });

  // ── isCompanyJob ──
  describe('isLombardOdierJob', () => {
    it('matches by companyKey', () => {
      expect(isLombardOdierJob({ companyKey: 'lombard-odier' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLombardOdierJob({ company: 'Lombard Odier' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLombardOdierJob({ url: 'https://lombardodier.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLombardOdierJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLombardOdierJob(null)).toBe(false);
      expect(isLombardOdierJob(undefined)).toBe(false);
      expect(isLombardOdierJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://lombardodier.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.lombardodier.com/job/456')).toBe(true);
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
      expect(slugify('Developer lombard-odier ch')).toBe('developer-lombard-odier-ch');
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
      id: 'lombard-odier-abc123',
      slug: 'test-position-lombard-odier-ch',
      slugByLocale: { en: 'test-position-lombard-odier-ch' },
      company: 'Lombard Odier',
      companyKey: 'lombard-odier',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://lombardodier.com/jobs/test',
      source: 'Lombard Odier Dedicated Parser',
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
      expect(validJob.id).toMatch(/^lombard-odier-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
