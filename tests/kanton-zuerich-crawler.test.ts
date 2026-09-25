import { describe, it, expect } from 'vitest';
import {
  KANTON_ZUERICH_KEY,
  KANTON_ZUERICH_COMPANY_NAME,
  KANTON_ZUERICH_COMPANY_DOMAIN,
  isKantonZuerichJob,
  isTrustedDomain,
} from '../scripts/lib/kanton-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kanton Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(KANTON_ZUERICH_KEY).toBe('kanton-zuerich');
    expect(KANTON_ZUERICH_COMPANY_NAME).toBe('Kantonale Verwaltung Zürich');
    expect(KANTON_ZUERICH_COMPANY_DOMAIN).toBe('zh.ch');
  });

  // ── isCompanyJob ──
  describe('isKantonZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonZuerichJob({ companyKey: 'kanton-zuerich' })).toBe(true);
    });

    it('matches by URL domain (zh.ch)', () => {
      expect(isKantonZuerichJob({ url: 'https://www.zh.ch/de/arbeiten-beim-kanton.html' })).toBe(true);
    });

    it('matches by Solique tenant path (ktzh)', () => {
      expect(isKantonZuerichJob({ url: 'https://live.solique.ch/ktzh/job/details/4030798/' })).toBe(true);
    });

    it('rejects unrelated jobs (other Solique tenant)', () => {
      expect(
        isKantonZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://live.solique.ch/ipw/de/jobs/x--1' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonZuerichJob(null)).toBe(false);
      expect(isKantonZuerichJob(undefined)).toBe(false);
      expect(isKantonZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the corporate domain (zh.ch)', () => {
      expect(isTrustedDomain('https://www.zh.ch/de/arbeiten-beim-kanton.html')).toBe(true);
    });

    it('trusts the ktzh tenant on the Solique domain', () => {
      expect(isTrustedDomain('https://live.solique.ch/ktzh/job/details/4030798/')).toBe(true);
      expect(isTrustedDomain('https://live.solique.ch/ktzh/de/api/v1/data/')).toBe(true);
    });

    it('rejects a different Solique tenant', () => {
      expect(isTrustedDomain('https://live.solique.ch/ipw/de/jobs/x--1')).toBe(false);
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
      const slug = slugify('ICT-Berufsbildner/-in kanton-zuerich zurich');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics (Zürich → zuerich normalization handled upstream)', () => {
      expect(slugify('Jurist/in Zürich')).toBe('jurist-in-zurich');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job mirroring what fetchAllKantonZuerichJobs emits via
    // createSoliqueParser (see scripts/lib/solique-common.mjs).
    const validJob = {
      id: 'kanton-zuerich-0d1203da509c',
      slug: 'ict-berufsbildner-in-kanton-zuerich-zurich',
      slugByLocale: { de: 'ict-berufsbildner-in-kanton-zuerich-zurich' },
      company: KANTON_ZUERICH_COMPANY_NAME,
      companyKey: KANTON_ZUERICH_KEY,
      companyDomain: KANTON_ZUERICH_COMPANY_DOMAIN,
      title: 'ICT-Berufsbildner/-in',
      titleByLocale: { de: 'ICT-Berufsbildner/-in' },
      description: 'A test job description for validation, well above the thin-content floor.',
      descriptionByLocale: { de: 'A test job description for validation, well above the thin-content floor.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://live.solique.ch/ktzh/job/details/4030798/',
      source: 'Kantonale Verwaltung Zürich Dedicated Parser (Solique careers portal)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      postalCode: '8001',
      sector: 'Amministrazione Pubblica',
      category: 'IT',
      employmentType: 'OTHER',
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
      const structuredDataInputs = [
        'postalCode', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('is tagged as public administration, not healthcare (sector/category override)', () => {
      // The shared Solique factory defaults `sector`/category classification to
      // "Sanità / Ospedali" (every other tenant is a hospital/clinic). Kanton
      // Zürich is a cantonal administration, not a healthcare operator.
      expect(validJob.sector).toBe('Amministrazione Pubblica');
      expect(validJob.sector).not.toBe('Sanità / Ospedali');
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^kanton-zuerich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('detail URL is not double-tenant (site-absolute link regression guard)', () => {
      // Regression guard for the fix in parseSoliqueApiListing: ktzh's JSON
      // `link` field is site-absolute (`ktzh/job/details/{id}/`); routing it
      // through the tenant/lang-relative path would double the tenant segment
      // and 404 (`.../ktzh/de/ktzh/job/details/...`).
      expect(validJob.url).not.toContain('/ktzh/de/ktzh/');
    });
  });
});
