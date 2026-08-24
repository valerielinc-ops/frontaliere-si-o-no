import { describe, it, expect } from 'vitest';
import {
  CIPPATRASPORTI_KEY,
  CIPPATRASPORTI_COMPANY_NAME,
  isCippatrasportiJob,
  isTrustedDomain,
} from '../scripts/lib/cippatrasporti-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Cippà Trasporti SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CIPPATRASPORTI_KEY).toBe('cippatrasporti');
    expect(CIPPATRASPORTI_COMPANY_NAME).toBe('Cippà Trasporti SA');
  });

  // ── isCompanyJob ──
  describe('isCippatrasportiJob', () => {
    it('matches by companyKey', () => {
      expect(isCippatrasportiJob({ companyKey: 'cippatrasporti' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCippatrasportiJob({ company: 'Cippà Trasporti SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCippatrasportiJob({ url: 'https://cippatrasporti.altamiraweb.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCippatrasportiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCippatrasportiJob(null)).toBe(false);
      expect(isCippatrasportiJob(undefined)).toBe(false);
      expect(isCippatrasportiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cippatrasporti.altamiraweb.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.cippatrasporti.altamiraweb.com/job/456')).toBe(true);
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
      expect(slugify('Developer cippatrasporti ch')).toBe('developer-cippatrasporti-ch');
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
      id: 'cippatrasporti-abc123',
      slug: 'test-position-cippatrasporti-ch',
      slugByLocale: { it: 'test-position-cippatrasporti-ch' },
      company: 'Cippà Trasporti SA',
      companyKey: 'cippatrasporti',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://cippatrasporti.altamiraweb.com/jobs/test',
      source: 'Cippà Trasporti SA Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^cippatrasporti-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
