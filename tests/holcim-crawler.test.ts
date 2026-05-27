import { describe, it, expect } from 'vitest';
import {
  HOLCIM_KEY,
  HOLCIM_COMPANY_NAME,
  isHolcimJob,
  isTrustedDomain,
} from '../scripts/lib/holcim-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Holcim Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HOLCIM_KEY).toBe('holcim');
    expect(HOLCIM_COMPANY_NAME).toBe('Holcim Group');
  });

  // ── isCompanyJob ──
  describe('isHolcimJob', () => {
    it('matches by companyKey', () => {
      expect(isHolcimJob({ companyKey: 'holcim' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHolcimJob({ company: 'Holcim Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHolcimJob({ url: 'https://holcim.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHolcimJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHolcimJob(null)).toBe(false);
      expect(isHolcimJob(undefined)).toBe(false);
      expect(isHolcimJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://holcim.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.holcim.com/job/456')).toBe(true);
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
      expect(slugify('Developer holcim ch')).toBe('developer-holcim-ch');
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
      id: 'holcim-abc123',
      slug: 'test-position-holcim-ch',
      slugByLocale: { en: 'test-position-holcim-ch' },
      company: 'Holcim Group',
      companyKey: 'holcim',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://holcim.com/jobs/test',
      source: 'Holcim Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^holcim-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
