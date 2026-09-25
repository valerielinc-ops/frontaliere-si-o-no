import { describe, it, expect } from 'vitest';
import {
  AUDEMARS_PIGUET_KEY,
  AUDEMARS_PIGUET_COMPANY_NAME,
  isAudemarsPiguetJob,
  isTrustedDomain,
} from '../scripts/lib/audemars-piguet-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Audemars Piguet crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AUDEMARS_PIGUET_KEY).toBe('audemars-piguet');
    expect(AUDEMARS_PIGUET_COMPANY_NAME).toBe('Audemars Piguet');
  });

  // ── isCompanyJob ──
  describe('isAudemarsPiguetJob', () => {
    it('matches by companyKey', () => {
      expect(isAudemarsPiguetJob({ companyKey: 'audemars-piguet' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAudemarsPiguetJob({ company: 'Audemars Piguet' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAudemarsPiguetJob({ url: 'https://audemarspiguet.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAudemarsPiguetJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAudemarsPiguetJob(null)).toBe(false);
      expect(isAudemarsPiguetJob(undefined)).toBe(false);
      expect(isAudemarsPiguetJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://audemarspiguet.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.audemarspiguet.com/job/456')).toBe(true);
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
      expect(slugify('Developer audemars-piguet ch')).toBe('developer-audemars-piguet-ch');
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
      id: 'audemars-piguet-abc123',
      slug: 'test-position-audemars-piguet-ch',
      slugByLocale: { fr: 'test-position-audemars-piguet-ch' },
      company: 'Audemars Piguet',
      companyKey: 'audemars-piguet',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://audemarspiguet.com/jobs/test',
      source: 'Audemars Piguet Dedicated Parser',
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
      expect(validJob.id).toMatch(/^audemars-piguet-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
