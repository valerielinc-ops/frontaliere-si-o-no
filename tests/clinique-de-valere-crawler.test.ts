import { describe, it, expect } from 'vitest';
import {
  CLINIQUE_DE_VALERE_KEY,
  CLINIQUE_DE_VALERE_COMPANY_NAME,
  isCliniqueDeValereJob,
  isTrustedDomain,
} from '../scripts/lib/clinique-de-valere-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Clinique de Valère crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLINIQUE_DE_VALERE_KEY).toBe('clinique-de-valere');
    expect(CLINIQUE_DE_VALERE_COMPANY_NAME).toBe('Clinique de Valère');
  });

  // ── isCompanyJob (SMN factory pattern: companyKey + company name only) ──
  describe('isCliniqueDeValereJob', () => {
    it('matches by companyKey', () => {
      expect(isCliniqueDeValereJob({ companyKey: 'clinique-de-valere' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCliniqueDeValereJob({ company: 'Clinique de Valère' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCliniqueDeValereJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCliniqueDeValereJob(null)).toBe(false);
      expect(isCliniqueDeValereJob(undefined)).toBe(false);
      expect(isCliniqueDeValereJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain (factory trusts swissmedical.net + smartrecruiters.com) ──
  describe('isTrustedDomain', () => {
    it('trusts swissmedical.net', () => {
      expect(isTrustedDomain('https://swissmedical.net/careers/job-123')).toBe(true);
    });

    it('trusts swissmedical.net subdomains', () => {
      expect(isTrustedDomain('https://www.swissmedical.net/fr/carriere/offres-emploi')).toBe(true);
    });

    it('trusts jobs.smartrecruiters.com (ATS host)', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-foo')).toBe(true);
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
      expect(slugify('Developer clinique-de-valere ch')).toBe('developer-clinique-de-valere-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'clinique-de-valere-abc123',
      slug: 'test-position-clinique-de-valere-ch',
      slugByLocale: { fr: 'test-position-clinique-de-valere-ch' },
      company: 'Clinique de Valère',
      companyKey: 'clinique-de-valere',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Sion',
      canton: 'VS',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-test',
      source: 'Clinique de Valère Dedicated Parser (SMN clinic=CDV)',
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
      expect(validJob.id).toMatch(/^clinique-de-valere-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
