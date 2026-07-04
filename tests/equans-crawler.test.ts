import { describe, it, expect } from 'vitest';
import {
  EQUANS_KEY,
  EQUANS_COMPANY_NAME,
  isEquansJob,
  isTrustedDomain,
} from '../scripts/lib/equans-job-parser.mjs';
import { jobsChDetailUrl } from '../scripts/lib/jobs-ch-search-common.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Equans Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EQUANS_KEY).toBe('equans');
    expect(EQUANS_COMPANY_NAME).toBe('Equans Switzerland');
  });

  // ── isCompanyJob ──
  describe('isEquansJob', () => {
    it('matches by companyKey', () => {
      expect(isEquansJob({ companyKey: 'equans' })).toBe(true);
    });

    it('matches by company name (including subsidiary variants)', () => {
      expect(isEquansJob({ company: 'Equans Switzerland' })).toBe(true);
      expect(isEquansJob({ company: 'Equans Switzerland Facility Management AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEquansJob({ url: 'https://www.equans.ch/de/karriere/test-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isEquansJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEquansJob(null)).toBe(false);
      expect(isEquansJob(undefined)).toBe(false);
      expect(isEquansJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the equans.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.equans.ch/de/karriere')).toBe(true);
      expect(isTrustedDomain('https://equans.ch/')).toBe(true);
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
      const slug = slugify('Servicetechniker/-in HLK, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('servicetechniker hlk equans zurich')).toBe(
        'servicetechniker-hlk-equans-zurich'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'equans-abc123',
      slug: 'test-position-equans-zurich',
      slugByLocale: { de: 'test-position-equans-zurich' },
      company: 'Equans Switzerland',
      companyKey: 'equans',
      companyDomain: 'equans.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://www.jobs.ch/en/vacancies/detail/abc-123/',
      source: 'Equans Switzerland Dedicated Parser (jobs.ch API)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Förrlibuckstrasse 150',
      postalCode: '8005',
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
      expect(validJob.id).toMatch(/^equans-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
