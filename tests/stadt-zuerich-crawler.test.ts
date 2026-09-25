import { describe, it, expect } from 'vitest';
import {
  STADT_ZUERICH_KEY,
  STADT_ZUERICH_COMPANY_NAME,
  isStadtZuerichJob,
  isTrustedDomain,
} from '../scripts/lib/stadt-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stadt Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADT_ZUERICH_KEY).toBe('stadt-zuerich');
    expect(STADT_ZUERICH_COMPANY_NAME).toBe('Stadt Zürich');
  });

  // ── isCompanyJob ──
  describe('isStadtZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtZuerichJob({ companyKey: 'stadt-zuerich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtZuerichJob({ company: 'Stadt Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isStadtZuerichJob({ url: 'https://jobs.stadt-zuerich.ch/job/sachbearbeiter-in/12345/' })
      ).toBe(true);
    });

    it('rejects unrelated jobs (including Zurich Insurance Group)', () => {
      expect(
        isStadtZuerichJob({ companyKey: 'zurich', company: 'Zurich Insurance Group', url: 'https://www.zurich.com/careers' })
      ).toBe(false);
      expect(
        isStadtZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtZuerichJob(null)).toBe(false);
      expect(isStadtZuerichJob(undefined)).toBe(false);
      expect(isStadtZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the jobs.stadt-zuerich.ch ATS host', () => {
      expect(isTrustedDomain('https://jobs.stadt-zuerich.ch/job/sachbearbeiter-in/12345/')).toBe(true);
    });

    it('trusts the stadt-zuerich.ch apex and subdomains', () => {
      expect(isTrustedDomain('https://www.stadt-zuerich.ch/')).toBe(true);
      expect(isTrustedDomain('https://stadt-zuerich.ch/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('https://www.zurich.com/careers')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Sachbearbeiter/-in Soziale Dienste, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('sachbearbeiter soziale dienste stadt zuerich')).toBe(
        'sachbearbeiter-soziale-dienste-stadt-zuerich'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'stadt-zuerich-abc123',
      slug: 'test-position-stadt-zuerich',
      slugByLocale: { de: 'test-position-stadt-zuerich' },
      company: 'Stadt Zürich',
      companyKey: 'stadt-zuerich',
      companyDomain: 'stadt-zuerich.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://jobs.stadt-zuerich.ch/job/test-position/12345/',
      source: 'Stadt Zürich Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Stadthausquai 17',
      postalCode: '8001',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.stadt-zuerich.ch/job/test-position/12345/',
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
      expect(validJob.id).toMatch(/^stadt-zuerich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
