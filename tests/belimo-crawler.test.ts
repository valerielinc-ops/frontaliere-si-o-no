import { describe, it, expect } from 'vitest';
import {
  BELIMO_KEY,
  BELIMO_COMPANY_NAME,
  isBelimoJob,
  isTrustedDomain,
} from '../scripts/lib/belimo-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Belimo crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BELIMO_KEY).toBe('belimo');
    expect(BELIMO_COMPANY_NAME).toBe('Belimo');
  });

  // ── isCompanyJob ──
  describe('isBelimoJob', () => {
    it('matches by companyKey', () => {
      expect(isBelimoJob({ companyKey: 'belimo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBelimoJob({ company: 'Belimo' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBelimoJob({ url: 'https://www.belimo.com/us/en_US/jobs/12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBelimoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBelimoJob(null)).toBe(false);
      expect(isBelimoJob(undefined)).toBe(false);
      expect(isBelimoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.belimo.com/us/en_US/jobs/12345')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.belimo.com/job/456')).toBe(true);
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
      expect(slugify('Einkäufer:in Hinwil')).toBe('einkaufer-in-hinwil');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Technician belimo hinwil')).toBe('technician-belimo-hinwil');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBelimoJobs emits)
    const validJob = {
      id: 'belimo-abc123',
      slug: 'test-position-belimo-hinwil',
      slugByLocale: { de: 'test-position-belimo-hinwil' },
      company: 'Belimo',
      companyKey: 'belimo',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Hinwil',
      canton: 'ZH',
      url: 'https://www.belimo.com/us/en_US/jobs/test',
      source: 'Belimo Dedicated Parser (custom job-listing widget)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Hinwil',
      addressRegion: 'ZH',
      streetAddress: 'Brunnenbachstrasse 1',
      postalCode: '8340',
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
      expect(validJob.id).toMatch(/^belimo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
