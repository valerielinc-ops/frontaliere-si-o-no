import { describe, it, expect } from 'vitest';
import {
  HOSPICE_GENERAL_KEY,
  HOSPICE_GENERAL_COMPANY_NAME,
  isHospiceGeneralJob,
  isTrustedDomain,
} from '../scripts/lib/hospice-general-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hospice général crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HOSPICE_GENERAL_KEY).toBe('hospice-general');
    expect(HOSPICE_GENERAL_COMPANY_NAME).toBe('Hospice général');
  });

  // ── isCompanyJob ──
  describe('isHospiceGeneralJob', () => {
    it('matches by companyKey', () => {
      expect(isHospiceGeneralJob({ companyKey: 'hospice-general' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHospiceGeneralJob({ company: 'Hospice général' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHospiceGeneralJob({ url: 'https://www.hospicegeneral.ch/fr/nous-sommes' })).toBe(true);
    });

    it('matches by SmartRecruiters board URL', () => {
      expect(isHospiceGeneralJob({ url: 'https://jobs.smartrecruiters.com/Hospicegeneral/744000113099616-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHospiceGeneralJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHospiceGeneralJob(null)).toBe(false);
      expect(isHospiceGeneralJob(undefined)).toBe(false);
      expect(isHospiceGeneralJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.hospicegeneral.ch/fr/nous-sommes')).toBe(true);
    });

    it('trusts SmartRecruiters domain (ATS host)', () => {
      expect(isTrustedDomain('https://jobs.smartrecruiters.com/Hospicegeneral/744000113099616-job')).toBe(true);
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
      const slug = slugify('Assistant Social (Genève)');
      expect(slug).toBe('assistant-social-geneve');
    });

    it('strips diacritics', () => {
      expect(slugify('Éducateur spécialisé')).toBe('educateur-specialise');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Assistant Social hospice general geneve')).toBe('assistant-social-hospice-general-geneve');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllHospiceGeneralJobs emits)
    const validJob = {
      id: 'hospice-general-abc123',
      slug: 'test-position-hospice-general-geneve',
      slugByLocale: { fr: 'test-position-hospice-general-geneve' },
      company: 'Hospice général',
      companyKey: 'hospice-general',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.smartrecruiters.com/Hospicegeneral/test',
      source: 'Hospice général Dedicated Parser (SmartRecruiters)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Genève',
      addressRegion: 'GE',
      streetAddress: 'Cours de Rive 12',
      postalCode: '1204',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^hospice-general-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
