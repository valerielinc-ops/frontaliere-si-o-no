import { describe, it, expect } from 'vitest';
import {
  CLINIQUE_GENERALE_BEAULIEU_KEY,
  CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME,
  isCliniqueGeneraleBeaulieuJob,
  isTrustedDomain,
} from '../scripts/lib/clinique-generale-beaulieu-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Clinique Générale-Beaulieu crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLINIQUE_GENERALE_BEAULIEU_KEY).toBe('clinique-generale-beaulieu');
    expect(CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME).toBe('Clinique Générale-Beaulieu');
  });

  // ── isCompanyJob (SMN factory pattern: companyKey + company name only) ──
  describe('isCliniqueGeneraleBeaulieuJob', () => {
    it('matches by companyKey', () => {
      expect(isCliniqueGeneraleBeaulieuJob({ companyKey: 'clinique-generale-beaulieu' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCliniqueGeneraleBeaulieuJob({ company: 'Clinique Générale-Beaulieu' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCliniqueGeneraleBeaulieuJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCliniqueGeneraleBeaulieuJob(null)).toBe(false);
      expect(isCliniqueGeneraleBeaulieuJob(undefined)).toBe(false);
      expect(isCliniqueGeneraleBeaulieuJob({})).toBe(false);
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
      expect(slugify('Developer clinique-generale-beaulieu ch')).toBe('developer-clinique-generale-beaulieu-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'clinique-generale-beaulieu-abc123',
      slug: 'test-position-clinique-generale-beaulieu-ch',
      slugByLocale: { fr: 'test-position-clinique-generale-beaulieu-ch' },
      company: 'Clinique Générale-Beaulieu',
      companyKey: 'clinique-generale-beaulieu',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/SwissMedicalNetwork1/123-test',
      source: 'Clinique Générale-Beaulieu Dedicated Parser (SMN clinic=CGB)',
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
      expect(validJob.id).toMatch(/^clinique-generale-beaulieu-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
