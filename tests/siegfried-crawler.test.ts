import { describe, it, expect } from 'vitest';
import {
  SIEGFRIED_KEY,
  SIEGFRIED_COMPANY_NAME,
  isSiegfriedJob,
  isTrustedDomain,
} from '../scripts/lib/siegfried-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Siegfried crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SIEGFRIED_KEY).toBe('siegfried');
    expect(SIEGFRIED_COMPANY_NAME).toBe('Siegfried');
  });

  // ── isCompanyJob ──
  describe('isSiegfriedJob', () => {
    it('matches by companyKey', () => {
      expect(isSiegfriedJob({ companyKey: 'siegfried' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSiegfriedJob({ company: 'Siegfried' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSiegfriedJob({ url: 'https://siegfried.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSiegfriedJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSiegfriedJob(null)).toBe(false);
      expect(isSiegfriedJob(undefined)).toBe(false);
      expect(isSiegfriedJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://siegfried.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.siegfried.ch/job/456')).toBe(true);
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
      expect(slugify('Developer siegfried ch')).toBe('developer-siegfried-ch');
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
      id: 'siegfried-abc123',
      slug: 'test-position-siegfried-ch',
      slugByLocale: { en: 'test-position-siegfried-ch' },
      company: 'Siegfried',
      companyKey: 'siegfried',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://siegfried.ch/jobs/test',
      source: 'Siegfried Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^siegfried-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
