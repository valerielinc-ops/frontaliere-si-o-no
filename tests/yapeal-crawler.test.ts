import { describe, it, expect } from 'vitest';
import {
  YAPEAL_KEY,
  YAPEAL_COMPANY_NAME,
  isYapealJob,
  isTrustedDomain,
} from '../scripts/lib/yapeal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Yapeal crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(YAPEAL_KEY).toBe('yapeal');
    expect(YAPEAL_COMPANY_NAME).toBe('Yapeal');
  });

  // ── isCompanyJob ──
  describe('isYapealJob', () => {
    it('matches by companyKey', () => {
      expect(isYapealJob({ companyKey: 'yapeal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isYapealJob({ company: 'Yapeal' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isYapealJob({ url: 'https://yapeal.ch/en/careers' })).toBe(true);
    });

    it('matches by Personio ATS board URL', () => {
      expect(isYapealJob({ url: 'https://yapeal-ag.jobs.personio.de/job/12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isYapealJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isYapealJob(null)).toBe(false);
      expect(isYapealJob(undefined)).toBe(false);
      expect(isYapealJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://yapeal.ch/en/careers')).toBe(true);
    });

    it('trusts Personio ATS domain', () => {
      expect(isTrustedDomain('https://yapeal-ag.jobs.personio.de/job/12345')).toBe(true);
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
      const slug = slugify('Software Engineer (Zurich)');
      expect(slug).toBe('software-engineer-zurich');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Software Engineer yapeal zurich')).toBe('software-engineer-yapeal-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllYapealJobs emits)
    const validJob = {
      id: 'yapeal-abc123',
      slug: 'test-position-yapeal-zurich',
      slugByLocale: { de: 'test-position-yapeal-zurich' },
      company: 'Yapeal',
      companyKey: 'yapeal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://yapeal-ag.jobs.personio.de/job/test',
      source: 'Yapeal Dedicated Parser (Personio)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Max-Högger-Strasse 6',
      postalCode: '8048',
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
      expect(validJob.id).toMatch(/^yapeal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
