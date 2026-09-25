import { describe, it, expect } from 'vitest';
import {
  KANTON_ST_GALLEN_KEY,
  KANTON_ST_GALLEN_COMPANY_NAME,
  isKantonStGallenJob,
  isTrustedDomain,
} from '../scripts/lib/kanton-st-gallen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kanton St. Gallen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KANTON_ST_GALLEN_KEY).toBe('kanton-st-gallen');
    expect(KANTON_ST_GALLEN_COMPANY_NAME).toBe('Kanton St. Gallen');
  });

  // ── isCompanyJob ──
  describe('isKantonStGallenJob', () => {
    it('matches by companyKey', () => {
      expect(isKantonStGallenJob({ companyKey: 'kanton-st-gallen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKantonStGallenJob({ company: 'Kanton St. Gallen' })).toBe(true);
    });

    it('matches by URL domain (Umantis tenant 2800)', () => {
      expect(
        isKantonStGallenJob({ url: 'https://recruitingapp-2800.umantis.com/Vacancies/123/Description/1' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isKantonStGallenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKantonStGallenJob(null)).toBe(false);
      expect(isKantonStGallenJob(undefined)).toBe(false);
      expect(isKantonStGallenJob({})).toBe(false);
    });

    // Dedup-nuance regression: discovery tagged this employer as
    // "jobs.ch (feed)" / "ictjobs.ch", but the real backend is a dedicated
    // Umantis tenant — the matcher must key off the real host, not the
    // misleading discovery tag.
    it('does not match by the misleading discovery-tag domain alone', () => {
      expect(
        isKantonStGallenJob({
          companyKey: 'other-company',
          company: 'Other',
          url: 'https://ictjobs.ch/offene-stellen/test/123',
        })
      ).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the Umantis tenant 2800 host', () => {
      expect(isTrustedDomain('https://recruitingapp-2800.umantis.com/Vacancies/456/Description/1')).toBe(true);
    });

    it('trusts the bare sg.ch domain and its subdomains', () => {
      expect(isTrustedDomain('https://sg.ch/')).toBe(true);
      expect(isTrustedDomain('https://stellen.sg.ch/')).toBe(true);
    });

    it('rejects other domains, including the misleading discovery-tag host', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('https://ictjobs.ch/')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Sachbearbeiter/-in Steueramt, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('sachbearbeiter steueramt kanton st gallen st gallen')).toBe(
        'sachbearbeiter-steueramt-kanton-st-gallen-st-gallen'
      );
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference, including the structured-data
    // fields required by Non-Negotiable #3.
    const validJob = {
      id: 'kanton-st-gallen-abc123',
      slug: 'test-position-kanton-st-gallen-st-gallen',
      slugByLocale: { de: 'test-position-kanton-st-gallen-st-gallen' },
      company: 'Kanton St. Gallen',
      companyKey: 'kanton-st-gallen',
      companyDomain: 'sg.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'St. Gallen',
      canton: 'SG',
      url: 'https://recruitingapp-2800.umantis.com/Vacancies/789/Description/1',
      source: 'Kanton St. Gallen Dedicated Parser (Umantis tenant 2800)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'St. Gallen',
      addressRegion: 'SG',
      streetAddress: '',
      postalCode: '9001',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://recruitingapp-2800.umantis.com/Vacancies/789/Description/1',
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
      expect(validJob.id).toMatch(/^kanton-st-gallen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
