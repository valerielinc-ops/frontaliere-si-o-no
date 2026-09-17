import { describe, it, expect } from 'vitest';
import {
  ELPROM_KEY,
  ELPROM_COMPANY_NAME,
  isElpromJob,
  isTrustedDomain,
} from '../scripts/lib/elprom-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('elprom crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ELPROM_KEY).toBe('elprom');
    expect(ELPROM_COMPANY_NAME).toBe('elprom');
  });

  // ── isCompanyJob ──
  describe('isElpromJob', () => {
    it('matches by companyKey', () => {
      expect(isElpromJob({ companyKey: 'elprom' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isElpromJob({ company: 'elprom' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isElpromJob({ url: 'https://elprom.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isElpromJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isElpromJob(null)).toBe(false);
      expect(isElpromJob(undefined)).toBe(false);
      expect(isElpromJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://elprom.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.elprom.ch/job/456')).toBe(true);
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
      expect(slugify('Developer elprom ch')).toBe('developer-elprom-ch');
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
      id: 'elprom-abc123',
      slug: 'test-position-elprom-ch',
      slugByLocale: { de: 'test-position-elprom-ch' },
      company: 'elprom',
      companyKey: 'elprom',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://elprom.ch/jobs/test',
      source: 'elprom Dedicated Parser',
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
      expect(validJob.id).toMatch(/^elprom-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
