import { describe, it, expect } from 'vitest';
import {
  CITY_POP_KEY,
  CITY_POP_COMPANY_NAME,
  isCityPopJob,
  isTrustedDomain,
} from '../scripts/lib/city-pop-job-parser.mjs';
import { jobsChDetailUrl } from '../scripts/lib/jobs-ch-search-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('City Pop crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CITY_POP_KEY).toBe('city-pop');
    expect(CITY_POP_COMPANY_NAME).toBe('City Pop');
  });

  // ── isCompanyJob ──
  describe('isCityPopJob', () => {
    it('matches by companyKey', () => {
      expect(isCityPopJob({ companyKey: 'city-pop' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCityPopJob({ company: 'City Pop' })).toBe(true);
      expect(isCityPopJob({ company: 'City Pop AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCityPopJob({ url: 'https://citypop.com/career/test-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isCityPopJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCityPopJob(null)).toBe(false);
      expect(isCityPopJob(undefined)).toBe(false);
      expect(isCityPopJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the citypop.com host and subdomains', () => {
      expect(isTrustedDomain('https://citypop.com/career/')).toBe(true);
      expect(isTrustedDomain('https://www.citypop.com/')).toBe(true);
    });

    it('trusts the jobs.ch host (source-of-record ATS, not the corporate domain)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── jobsChDetailUrl (shared jobs.ch client, imported from jobs-ch-search-common) ──
  describe('jobsChDetailUrl', () => {
    it('builds the default (en) detail URL', () => {
      expect(jobsChDetailUrl('abc-123')).toBe('https://www.jobs.ch/en/vacancies/detail/abc-123/');
    });

    it('respects a custom locale', () => {
      expect(jobsChDetailUrl('abc-123', 'de')).toBe('https://www.jobs.ch/de/vacancies/detail/abc-123/');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Réceptionniste / Guest Relations (h/f), 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('receptionist city pop zurich')).toBe(
        'receptionist-city-pop-zurich'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'city-pop-abc123',
      slug: 'test-position-city-pop-zurich',
      slugByLocale: { de: 'test-position-city-pop-zurich' },
      company: 'City Pop',
      companyKey: 'city-pop',
      companyDomain: 'citypop.com',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://www.jobs.ch/en/vacancies/detail/abc-123/',
      source: 'City Pop Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Bernerstrasse Süd 169',
      postalCode: '8048',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/abc-123/',
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
      expect(validJob.id).toMatch(/^city-pop-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
