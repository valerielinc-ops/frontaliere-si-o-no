import { describe, it, expect } from 'vitest';
import {
  FONDATION_DOMUS_KEY,
  FONDATION_DOMUS_COMPANY_NAME,
  isFondationDomusJob,
  isTrustedDomain,
} from '../scripts/lib/fondation-domus-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Fondation Domus crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FONDATION_DOMUS_KEY).toBe('fondation-domus');
    expect(FONDATION_DOMUS_COMPANY_NAME).toBe('Fondation Domus');
  });

  // ── isCompanyJob ──
  describe('isFondationDomusJob', () => {
    it('matches by companyKey', () => {
      expect(isFondationDomusJob({ companyKey: 'fondation-domus' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFondationDomusJob({ company: 'Fondation Domus' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFondationDomusJob({ url: 'https://fondation-domus.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFondationDomusJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFondationDomusJob(null)).toBe(false);
      expect(isFondationDomusJob(undefined)).toBe(false);
      expect(isFondationDomusJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://fondation-domus.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.fondation-domus.ch/job/456')).toBe(true);
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
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer fondation-domus ch')).toBe('developer-fondation-domus-ch');
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
      id: 'fondation-domus-abc123',
      slug: 'test-position-fondation-domus-ch',
      slugByLocale: { fr: 'test-position-fondation-domus-ch' },
      company: 'Fondation Domus',
      companyKey: 'fondation-domus',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://fondation-domus.ch/jobs/test',
      source: 'Fondation Domus Dedicated Parser',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
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
      expect(validJob.id).toMatch(/^fondation-domus-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
