import { describe, it, expect } from 'vitest';
import {
  VAUDOISE_KEY,
  VAUDOISE_COMPANY_NAME,
  isVaudoiseJob,
  isTrustedDomain,
} from '../scripts/lib/vaudoise-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Vaudoise Assurances crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VAUDOISE_KEY).toBe('vaudoise');
    expect(VAUDOISE_COMPANY_NAME).toBe('Vaudoise Assurances');
  });

  // ── isCompanyJob ──
  describe('isVaudoiseJob', () => {
    it('matches by companyKey', () => {
      expect(isVaudoiseJob({ companyKey: 'vaudoise' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isVaudoiseJob({ company: 'Vaudoise Assurances' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVaudoiseJob({ url: 'https://vaudoise.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVaudoiseJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVaudoiseJob(null)).toBe(false);
      expect(isVaudoiseJob(undefined)).toBe(false);
      expect(isVaudoiseJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vaudoise.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vaudoise.ch/job/456')).toBe(true);
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
      expect(slugify('Developer vaudoise ch')).toBe('developer-vaudoise-ch');
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
      id: 'vaudoise-abc123',
      slug: 'test-position-vaudoise-ch',
      slugByLocale: { fr: 'test-position-vaudoise-ch' },
      company: 'Vaudoise Assurances',
      companyKey: 'vaudoise',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vaudoise.ch/jobs/test',
      source: 'Vaudoise Assurances Dedicated Parser',
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
      expect(validJob.id).toMatch(/^vaudoise-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
