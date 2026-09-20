import { describe, it, expect } from 'vitest';
import {
  BENU_KEY,
  BENU_COMPANY_NAME,
  isBenuJob,
  isTrustedDomain,
} from '../scripts/lib/benu-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('benu crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BENU_KEY).toBe('benu');
    expect(BENU_COMPANY_NAME).toBe('benu');
  });

  // ── isCompanyJob ──
  describe('isBenuJob', () => {
    it('matches by companyKey', () => {
      expect(isBenuJob({ companyKey: 'benu' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBenuJob({ company: 'benu' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBenuJob({ url: 'https://job.benu.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBenuJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBenuJob(null)).toBe(false);
      expect(isBenuJob(undefined)).toBe(false);
      expect(isBenuJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://job.benu.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.job.benu.ch/job/456')).toBe(true);
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
      expect(slugify('Developer benu ch')).toBe('developer-benu-ch');
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
      id: 'benu-abc123',
      slug: 'test-position-benu-ch',
      slugByLocale: { fr: 'test-position-benu-ch' },
      company: 'benu',
      companyKey: 'benu',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://job.benu.ch/jobs/test',
      source: 'benu Dedicated Parser',
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
      expect(validJob.id).toMatch(/^benu-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
