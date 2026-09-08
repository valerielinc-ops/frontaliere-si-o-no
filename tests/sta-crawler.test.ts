import { describe, it, expect } from 'vitest';
import {
  STA_KEY,
  STA_COMPANY_NAME,
  isStaJob,
  isTrustedDomain,
} from '../scripts/lib/sta-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('STA Personal AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STA_KEY).toBe('sta');
    expect(STA_COMPANY_NAME).toBe('STA Personal AG');
  });

  // ── isCompanyJob ──
  describe('isStaJob', () => {
    it('matches by companyKey', () => {
      expect(isStaJob({ companyKey: 'sta' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStaJob({ company: 'STA Personal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStaJob({ url: 'https://sta.jobs/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStaJob(null)).toBe(false);
      expect(isStaJob(undefined)).toBe(false);
      expect(isStaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sta.jobs/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.sta.jobs/job/456')).toBe(true);
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
      expect(slugify('Developer sta ch')).toBe('developer-sta-ch');
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
      id: 'sta-abc123',
      slug: 'test-position-sta-ch',
      slugByLocale: { de: 'test-position-sta-ch' },
      company: 'STA Personal AG',
      companyKey: 'sta',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://sta.jobs/jobs/test',
      source: 'STA Personal AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^sta-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
