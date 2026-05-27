import { describe, it, expect } from 'vitest';
import {
  AROSA_LENZERHEIDE_KEY,
  AROSA_LENZERHEIDE_COMPANY_NAME,
  isArosaLenzerheideJob,
  isTrustedDomain,
} from '../scripts/lib/arosa-lenzerheide-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Arosa Lenzerheide crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AROSA_LENZERHEIDE_KEY).toBe('arosa-lenzerheide');
    expect(AROSA_LENZERHEIDE_COMPANY_NAME).toBe('Arosa Lenzerheide');
  });

  // ── isCompanyJob ──
  describe('isArosaLenzerheideJob', () => {
    it('matches by companyKey', () => {
      expect(isArosaLenzerheideJob({ companyKey: 'arosa-lenzerheide' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isArosaLenzerheideJob({ company: 'Arosa Lenzerheide' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isArosaLenzerheideJob({ url: 'https://arosalenzerheide.swiss/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isArosaLenzerheideJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isArosaLenzerheideJob(null)).toBe(false);
      expect(isArosaLenzerheideJob(undefined)).toBe(false);
      expect(isArosaLenzerheideJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://arosalenzerheide.swiss/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.arosalenzerheide.swiss/job/456')).toBe(true);
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
      expect(slugify('Developer arosa-lenzerheide ch')).toBe('developer-arosa-lenzerheide-ch');
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
      id: 'arosa-lenzerheide-abc123',
      slug: 'test-position-arosa-lenzerheide-ch',
      slugByLocale: { de: 'test-position-arosa-lenzerheide-ch' },
      company: 'Arosa Lenzerheide',
      companyKey: 'arosa-lenzerheide',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://arosalenzerheide.swiss/jobs/test',
      source: 'Arosa Lenzerheide Dedicated Parser',
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
      expect(validJob.id).toMatch(/^arosa-lenzerheide-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
