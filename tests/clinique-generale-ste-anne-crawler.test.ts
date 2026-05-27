import { describe, it, expect } from 'vitest';
import {
  CLINIQUE_GENERALE_STE_ANNE_KEY,
  CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME,
  isCliniqueGeneraleSteAnneJob,
  isTrustedDomain,
} from '../scripts/lib/clinique-generale-ste-anne-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Clinique Générale Ste-Anne crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLINIQUE_GENERALE_STE_ANNE_KEY).toBe('clinique-generale-ste-anne');
    expect(CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME).toBe('Clinique Générale Ste-Anne');
  });

  // ── isCompanyJob (SMN factory pattern: companyKey + company name only) ──
  describe('isCliniqueGeneraleSteAnneJob', () => {
    it('matches by companyKey', () => {
      expect(isCliniqueGeneraleSteAnneJob({ companyKey: 'clinique-generale-ste-anne' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCliniqueGeneraleSteAnneJob({ company: 'Clinique Générale Ste-Anne' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCliniqueGeneraleSteAnneJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCliniqueGeneraleSteAnneJob(null)).toBe(false);
      expect(isCliniqueGeneraleSteAnneJob(undefined)).toBe(false);
      expect(isCliniqueGeneraleSteAnneJob({})).toBe(false);
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
      expect(slugify('Developer clinique-generale-ste-anne ch')).toBe('developer-clinique-generale-ste-anne-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'clinique-generale-ste-anne-abc123',
      slug: 'test-position-clinique-generale-ste-anne-ch',
      slugByLocale: { fr: 'test-position-clinique-generale-ste-anne-ch' },
      company: 'Clinique Générale Ste-Anne',
      companyKey: 'clinique-generale-ste-anne',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Fribourg',
      canton: 'FR',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-test',
      source: 'Clinique Générale Ste-Anne Dedicated Parser (SMN clinic=GSM)',
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
      expect(validJob.id).toMatch(/^clinique-generale-ste-anne-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
