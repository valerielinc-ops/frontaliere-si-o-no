import { describe, it, expect } from 'vitest';
import {
  FUSALP_KEY,
  FUSALP_COMPANY_NAME,
  isFusalpJob,
  isTrustedDomain,
} from '../scripts/lib/fusalp-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Fusalp crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FUSALP_KEY).toBe('fusalp');
    expect(FUSALP_COMPANY_NAME).toBe('Fusalp');
  });

  // ── isCompanyJob ──
  describe('isFusalpJob', () => {
    it('matches by companyKey', () => {
      expect(isFusalpJob({ companyKey: 'fusalp' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFusalpJob({ company: 'Fusalp' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isFusalpJob({ url: 'https://fusalp.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isFusalpJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFusalpJob(null)).toBe(false);
      expect(isFusalpJob(undefined)).toBe(false);
      expect(isFusalpJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://fusalp.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.fusalp.com/job/456')).toBe(true);
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
      expect(slugify('Developer fusalp ch')).toBe('developer-fusalp-ch');
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
      id: 'fusalp-abc123',
      slug: 'test-position-fusalp-ch',
      slugByLocale: { fr: 'test-position-fusalp-ch' },
      company: 'Fusalp',
      companyKey: 'fusalp',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://fusalp.com/jobs/test',
      source: 'Fusalp Dedicated Parser',
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
      expect(validJob.id).toMatch(/^fusalp-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
