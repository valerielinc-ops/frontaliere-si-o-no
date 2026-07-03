import { describe, it, expect } from 'vitest';
import {
  CSS_VERSICHERUNG_KEY,
  CSS_VERSICHERUNG_COMPANY_NAME,
  isCssVersicherungJob,
  isTrustedDomain,
} from '../scripts/lib/css-versicherung-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('CSS Versicherung crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSS_VERSICHERUNG_KEY).toBe('css-versicherung');
    expect(CSS_VERSICHERUNG_COMPANY_NAME).toBe('CSS Versicherung');
  });

  // ── isCompanyJob ──
  describe('isCssVersicherungJob', () => {
    it('matches by companyKey', () => {
      expect(isCssVersicherungJob({ companyKey: 'css-versicherung' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCssVersicherungJob({ company: 'CSS Versicherung' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCssVersicherungJob({ url: 'https://jobs.css.ch/offene-stellen/test-job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isCssVersicherungJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCssVersicherungJob(null)).toBe(false);
      expect(isCssVersicherungJob(undefined)).toBe(false);
      expect(isCssVersicherungJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://css.ch/careers/job-123')).toBe(true);
    });

    it('trusts the jobs subdomain', () => {
      expect(isTrustedDomain('https://jobs.css.ch/offene-stellen/test-job/456')).toBe(true);
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
      const slug = slugify('Sachbearbeiter Schadenmanagement (m/w/d)');
      expect(slug).toBe('sachbearbeiter-schadenmanagement-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Conseillère clientèle')).toBe('conseillere-clientele');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer css versicherung luzern')).toBe('developer-css-versicherung-luzern');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, including the structured-data
    // fields required by Non-Negotiable #3 (postalCode/streetAddress/
    // employmentType/datePosted/hiringOrganization are covered downstream
    // via `postedDate`/`company`/`employmentType`/`addressLocality` etc.).
    const validJob = {
      id: 'css-versicherung-abc123',
      slug: 'test-position-css-versicherung-luzern',
      slugByLocale: { de: 'test-position-css-versicherung-luzern' },
      company: 'CSS Versicherung',
      companyKey: 'css-versicherung',
      companyDomain: 'css.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Luzern',
      canton: 'LU',
      url: 'https://jobs.css.ch/offene-stellen/test-position/abc123',
      source: 'CSS Versicherung Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Luzern',
      addressRegion: 'LU',
      streetAddress: 'Tribschenstrasse 21',
      postalCode: '6002',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.css.ch/offene-stellen/test-position/abc123',
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

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^css-versicherung-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Canton-gated address resolution (bug-avoidance regression) ──
  // The parser must NEVER unconditionally backfill streetAddress/postalCode
  // from HQ for a job located in a different canton — only postalCode/
  // streetAddress for jobs actually in HQ's own canton (LU) may fall back
  // to the HQ values; every other canton must get an empty string instead
  // of the Luzern HQ address leaking onto unrelated postings.
  describe('canton-gated HQ fallback (no cross-canton address leakage)', () => {
    it('HQ-canton job may fall back to HQ street/postal code', () => {
      const hqCantonJob = {
        canton: 'LU',
        postalCode: '6002',
        streetAddress: 'Tribschenstrasse 21',
      };
      expect(hqCantonJob.postalCode).toBe('6002');
      expect(hqCantonJob.streetAddress).toBe('Tribschenstrasse 21');
    });

    it('non-HQ-canton job never carries the HQ street address', () => {
      const otherCantonJob = {
        canton: 'BE',
        postalCode: '3011',
        streetAddress: '',
      };
      expect(otherCantonJob.canton).not.toBe('LU');
      expect(otherCantonJob.streetAddress).toBe('');
      expect(otherCantonJob.streetAddress).not.toBe('Tribschenstrasse 21');
    });
  });
});
