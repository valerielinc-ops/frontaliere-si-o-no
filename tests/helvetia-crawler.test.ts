import { describe, it, expect } from 'vitest';
import {
  HELVETIA_KEY,
  HELVETIA_COMPANY_NAME,
  isHelvetiaJob,
  isTrustedDomain,
} from '../scripts/lib/helvetia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Helvetia Versicherungen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HELVETIA_KEY).toBe('helvetia');
    expect(HELVETIA_COMPANY_NAME).toBe('Helvetia Versicherungen');
  });

  // ── isCompanyJob ──
  describe('isHelvetiaJob', () => {
    it('matches by companyKey', () => {
      expect(isHelvetiaJob({ companyKey: 'helvetia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHelvetiaJob({ company: 'Helvetia Versicherungen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHelvetiaJob({ url: 'https://helvetia.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHelvetiaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHelvetiaJob(null)).toBe(false);
      expect(isHelvetiaJob(undefined)).toBe(false);
      expect(isHelvetiaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://helvetia.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.helvetia.com/job/456')).toBe(true);
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
      expect(slugify('Developer helvetia ch')).toBe('developer-helvetia-ch');
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
      id: 'helvetia-abc123',
      slug: 'test-position-helvetia-ch',
      slugByLocale: { de: 'test-position-helvetia-ch' },
      company: 'Helvetia Versicherungen',
      companyKey: 'helvetia',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://helvetia.com/jobs/test',
      source: 'Helvetia Versicherungen Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^helvetia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
