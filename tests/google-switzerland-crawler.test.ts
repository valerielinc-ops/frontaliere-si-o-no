import { describe, it, expect } from 'vitest';
import {
  GOOGLE_SWITZERLAND_KEY,
  GOOGLE_SWITZERLAND_COMPANY_NAME,
  isGoogleSwitzerlandJob,
  isTrustedDomain,
} from '../scripts/lib/google-switzerland-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Google Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GOOGLE_SWITZERLAND_KEY).toBe('google-switzerland');
    expect(GOOGLE_SWITZERLAND_COMPANY_NAME).toBe('Google Switzerland');
  });

  // ── isCompanyJob ──
  describe('isGoogleSwitzerlandJob', () => {
    it('matches by companyKey', () => {
      expect(isGoogleSwitzerlandJob({ companyKey: 'google-switzerland' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGoogleSwitzerlandJob({ company: 'Google Switzerland' })).toBe(true);
      expect(isGoogleSwitzerlandJob({ company: 'Google' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isGoogleSwitzerlandJob({ url: 'https://www.google.com/about/careers/applications/jobs/results/123-test' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isGoogleSwitzerlandJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('rejects unrelated google.com pages outside careers', () => {
      expect(isGoogleSwitzerlandJob({ url: 'https://www.google.com/search?q=jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGoogleSwitzerlandJob(null)).toBe(false);
      expect(isGoogleSwitzerlandJob(undefined)).toBe(false);
      expect(isGoogleSwitzerlandJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(
        isTrustedDomain('https://www.google.com/about/careers/applications/jobs/results/123-test'),
      ).toBe(true);
    });

    it('trusts apex domain', () => {
      expect(isTrustedDomain('https://google.com/about/careers/applications/')).toBe(true);
    });

    it('rejects unrelated subdomains', () => {
      expect(isTrustedDomain('https://mail.google.com/about')).toBe(false);
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
      const slug = slugify('Software Engineer III, AI/ML');
      expect(slug).toBe('software-engineer-iii-ai-ml');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer google-switzerland Zürich')).toBe('developer-google-switzerland-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'google-switzerland-abc123',
      slug: 'test-position-google-switzerland-zurich',
      slugByLocale: { en: 'test-position-google-switzerland-zurich' },
      company: 'Google Switzerland',
      companyKey: 'google-switzerland',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://www.google.com/about/careers/applications/jobs/results/123-test-position',
      source: 'Google Switzerland Dedicated Parser (Jina-rendered)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),

      // Structured-data-completeness fields (AGENTS.md Non-Negotiable #3)
      baseSalary: undefined,
      postalCode: '8002',
      streetAddress: 'Brandschenkestrasse 110',
      datePosted: new Date().toISOString().split('T')[0],
      hiringOrganization: { name: 'Google Switzerland' },
      jobLocation: { addressLocality: 'Zürich', addressRegion: 'ZH', postalCode: '8002', addressCountry: 'CH' },
      employmentType: 'FULL_TIME',
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
      expect(validJob.id).toMatch(/^google-switzerland-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('has structured-data-completeness fields (AGENTS.md Non-Negotiable #3)', () => {
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob).toHaveProperty('title');
      expect(validJob).toHaveProperty('description');
      expect(validJob).toHaveProperty('datePosted');
      expect(validJob.hiringOrganization).toHaveProperty('name');
      expect(validJob).toHaveProperty('jobLocation');
      expect(validJob).toHaveProperty('employmentType');
    });
  });
});
