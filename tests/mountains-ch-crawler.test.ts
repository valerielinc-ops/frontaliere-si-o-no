import { describe, it, expect } from 'vitest';
import {
  MOUNTAINS_CH_KEY,
  MOUNTAINS_CH_COMPANY_NAME,
  isMountainsChJob,
  isTrustedDomain,
} from '../scripts/lib/mountains-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Engadin St. Moritz Mountains AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MOUNTAINS_CH_KEY).toBe('mountains-ch');
    expect(MOUNTAINS_CH_COMPANY_NAME).toBe('Engadin St. Moritz Mountains AG');
  });

  // ── isCompanyJob ──
  describe('isMountainsChJob', () => {
    it('matches by companyKey', () => {
      expect(isMountainsChJob({ companyKey: 'mountains-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMountainsChJob({ company: 'Engadin St. Moritz Mountains AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMountainsChJob({ url: 'https://mountains.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMountainsChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMountainsChJob(null)).toBe(false);
      expect(isMountainsChJob(undefined)).toBe(false);
      expect(isMountainsChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://mountains.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.mountains.ch/job/456')).toBe(true);
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
      expect(slugify('Developer mountains-ch ch')).toBe('developer-mountains-ch-ch');
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
      id: 'mountains-ch-abc123',
      slug: 'test-position-mountains-ch-ch',
      slugByLocale: { de: 'test-position-mountains-ch-ch' },
      company: 'Engadin St. Moritz Mountains AG',
      companyKey: 'mountains-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://mountains.ch/jobs/test',
      source: 'Engadin St. Moritz Mountains AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^mountains-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
