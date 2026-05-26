import { describe, it, expect } from 'vitest';
import {
  SPITAL_OBERENGADIN_KEY,
  SPITAL_OBERENGADIN_COMPANY_NAME,
  isSpitalOberengadinJob,
  isTrustedDomain,
} from '../scripts/lib/spital-oberengadin-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Spital Oberengadin crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SPITAL_OBERENGADIN_KEY).toBe('spital-oberengadin');
    expect(SPITAL_OBERENGADIN_COMPANY_NAME).toBe('Spital Oberengadin');
  });

  // ── isCompanyJob ──
  describe('isSpitalOberengadinJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalOberengadinJob({ companyKey: 'spital-oberengadin' })).toBe(true);
    });

    it('matches by Solique tenant URL', () => {
      expect(isSpitalOberengadinJob({ url: 'https://live.solique.ch/stiftung-gesundheitsversorgung-oberengadin/job/details/4008652' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSpitalOberengadinJob({ url: 'https://spital-oberengadin.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSpitalOberengadinJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSpitalOberengadinJob(null)).toBe(false);
      expect(isSpitalOberengadinJob(undefined)).toBe(false);
      expect(isSpitalOberengadinJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://spital-oberengadin.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.spital-oberengadin.ch/job/456')).toBe(true);
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
      expect(slugify('Developer spital-oberengadin ch')).toBe('developer-spital-oberengadin-ch');
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
      id: 'spital-oberengadin-abc123',
      slug: 'test-position-spital-oberengadin-ch',
      slugByLocale: { de: 'test-position-spital-oberengadin-ch' },
      company: 'Spital Oberengadin',
      companyKey: 'spital-oberengadin',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://spital-oberengadin.ch/jobs/test',
      source: 'Spital Oberengadin Dedicated Parser',
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
      expect(validJob.id).toMatch(/^spital-oberengadin-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
