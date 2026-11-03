import { describe, it, expect } from 'vitest';
import {
  LIPSUISSE_CH_KEY,
  LIPSUISSE_CH_COMPANY_NAME,
  isLipsuisseChJob,
  isTrustedDomain,
} from '../scripts/lib/lipsuisse-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('LIP Suisse crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LIPSUISSE_CH_KEY).toBe('lipsuisse-ch');
    expect(LIPSUISSE_CH_COMPANY_NAME).toBe('LIP Suisse');
  });

  // ── isCompanyJob ──
  describe('isLipsuisseChJob', () => {
    it('matches by companyKey', () => {
      expect(isLipsuisseChJob({ companyKey: 'lipsuisse-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLipsuisseChJob({ company: 'LIP Suisse' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLipsuisseChJob({ url: 'https://lipsuisse.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLipsuisseChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLipsuisseChJob(null)).toBe(false);
      expect(isLipsuisseChJob(undefined)).toBe(false);
      expect(isLipsuisseChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://lipsuisse.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.lipsuisse.ch/job/456')).toBe(true);
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
      expect(slugify('Developer lipsuisse-ch ch')).toBe('developer-lipsuisse-ch-ch');
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
      id: 'lipsuisse-ch-abc123',
      slug: 'test-position-lipsuisse-ch-ch',
      slugByLocale: { fr: 'test-position-lipsuisse-ch-ch' },
      company: 'LIP Suisse',
      companyKey: 'lipsuisse-ch',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://lipsuisse.ch/jobs/test',
      source: 'LIP Suisse Dedicated Parser',
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
      expect(validJob.id).toMatch(/^lipsuisse-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
