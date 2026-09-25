import { describe, it, expect } from 'vitest';
import {
  ARXADA_KEY,
  ARXADA_COMPANY_NAME,
  isArxadaJob,
  isTrustedDomain,
} from '../scripts/lib/arxada-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Arxada crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ARXADA_KEY).toBe('arxada');
    expect(ARXADA_COMPANY_NAME).toBe('Arxada');
  });

  // ── isCompanyJob ──
  describe('isArxadaJob', () => {
    it('matches by companyKey', () => {
      expect(isArxadaJob({ companyKey: 'arxada' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isArxadaJob({ company: 'Arxada' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isArxadaJob({ url: 'https://arxada.com/jobs/123' })).toBe(true);
    });

    it('matches by Workday URL', () => {
      expect(isArxadaJob({ url: 'https://lsi.wd3.myworkdayjobs.com/en/Arxada_Careers/job/CH---Visp/Test_R12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isArxadaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isArxadaJob(null)).toBe(false);
      expect(isArxadaJob(undefined)).toBe(false);
      expect(isArxadaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://arxada.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.arxada.com/job/456')).toBe(true);
    });

    it('trusts Workday host', () => {
      expect(isTrustedDomain('https://lsi.wd3.myworkdayjobs.com/en/Arxada_Careers/job/CH---Visp/Test_R12345')).toBe(true);
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
      expect(slugify('Developer arxada ch')).toBe('developer-arxada-ch');
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
      id: 'arxada-abc123',
      slug: 'test-position-arxada-ch',
      slugByLocale: { en: 'test-position-arxada-ch' },
      company: 'Arxada',
      companyKey: 'arxada',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://arxada.com/jobs/test',
      source: 'Arxada Dedicated Parser (Workday)',
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
      expect(validJob.id).toMatch(/^arxada-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
