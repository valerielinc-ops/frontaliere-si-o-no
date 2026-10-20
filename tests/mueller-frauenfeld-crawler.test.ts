import { describe, it, expect } from 'vitest';
import {
  MUELLER_FRAUENFELD_KEY,
  MUELLER_FRAUENFELD_COMPANY_NAME,
  isMuellerFrauenfeldJob,
  isTrustedDomain,
} from '../scripts/lib/mueller-frauenfeld-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('mueller-frauenfeld crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MUELLER_FRAUENFELD_KEY).toBe('mueller-frauenfeld');
    expect(MUELLER_FRAUENFELD_COMPANY_NAME).toBe('mueller-frauenfeld');
  });

  // ── isCompanyJob ──
  describe('isMuellerFrauenfeldJob', () => {
    it('matches by companyKey', () => {
      expect(isMuellerFrauenfeldJob({ companyKey: 'mueller-frauenfeld' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMuellerFrauenfeldJob({ company: 'mueller-frauenfeld' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMuellerFrauenfeldJob({ url: 'https://mueller-frauenfeld.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMuellerFrauenfeldJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMuellerFrauenfeldJob(null)).toBe(false);
      expect(isMuellerFrauenfeldJob(undefined)).toBe(false);
      expect(isMuellerFrauenfeldJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mueller-frauenfeld.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mueller-frauenfeld.ch/job/456')).toBe(true);
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
      expect(slugify('Developer mueller-frauenfeld ch')).toBe('developer-mueller-frauenfeld-ch');
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
      id: 'mueller-frauenfeld-abc123',
      slug: 'test-position-mueller-frauenfeld-ch',
      slugByLocale: { fr: 'test-position-mueller-frauenfeld-ch' },
      company: 'mueller-frauenfeld',
      companyKey: 'mueller-frauenfeld',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mueller-frauenfeld.ch/jobs/test',
      source: 'mueller-frauenfeld Dedicated Parser',
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
      expect(validJob.id).toMatch(/^mueller-frauenfeld-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
