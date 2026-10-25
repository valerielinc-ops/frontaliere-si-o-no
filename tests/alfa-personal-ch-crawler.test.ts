import { describe, it, expect } from 'vitest';
import {
  ALFA_PERSONAL_CH_KEY,
  ALFA_PERSONAL_CH_COMPANY_NAME,
  isAlfaPersonalChJob,
  isTrustedDomain,
} from '../scripts/lib/alfa-personal-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Alfa Personal GmbH crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ALFA_PERSONAL_CH_KEY).toBe('alfa-personal-ch');
    expect(ALFA_PERSONAL_CH_COMPANY_NAME).toBe('Alfa Personal GmbH');
  });

  // ── isCompanyJob ──
  describe('isAlfaPersonalChJob', () => {
    it('matches by companyKey', () => {
      expect(isAlfaPersonalChJob({ companyKey: 'alfa-personal-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAlfaPersonalChJob({ company: 'Alfa Personal GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAlfaPersonalChJob({ url: 'https://alfa-personal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAlfaPersonalChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAlfaPersonalChJob(null)).toBe(false);
      expect(isAlfaPersonalChJob(undefined)).toBe(false);
      expect(isAlfaPersonalChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://alfa-personal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.alfa-personal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer alfa-personal-ch ch')).toBe('developer-alfa-personal-ch-ch');
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
      id: 'alfa-personal-ch-abc123',
      slug: 'test-position-alfa-personal-ch-ch',
      slugByLocale: { de: 'test-position-alfa-personal-ch-ch' },
      company: 'Alfa Personal GmbH',
      companyKey: 'alfa-personal-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://alfa-personal.ch/jobs/test',
      source: 'Alfa Personal GmbH Dedicated Parser',
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
      expect(validJob.id).toMatch(/^alfa-personal-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
