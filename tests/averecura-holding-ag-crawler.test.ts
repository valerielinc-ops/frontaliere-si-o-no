import { describe, it, expect } from 'vitest';
import {
  AVERECURA_HOLDING_AG_KEY,
  AVERECURA_HOLDING_AG_COMPANY_NAME,
  isAverecuraHoldingAgJob,
  isTrustedDomain,
} from '../scripts/lib/averecura-holding-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('averecura holding ag crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(AVERECURA_HOLDING_AG_KEY).toBe('averecura-holding-ag');
    expect(AVERECURA_HOLDING_AG_COMPANY_NAME).toBe('averecura holding ag');
  });

  // ── isCompanyJob ──
  describe('isAverecuraHoldingAgJob', () => {
    it('matches by companyKey', () => {
      expect(isAverecuraHoldingAgJob({ companyKey: 'averecura-holding-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAverecuraHoldingAgJob({ company: 'averecura holding ag' })).toBe(true);
    });

    it('matches by the averecura Refline tenant path', () => {
      expect(isAverecuraHoldingAgJob({ url: 'https://app.reflinejobs.io/3034/0108/jobs/123' })).toBe(true);
    });

    it('rejects another employer on the shared Refline host', () => {
      const otherTenant = { company: 'Other AG', url: 'https://app.reflinejobs.io/9999/0108/job/1' };
      expect(isAverecuraHoldingAgJob(otherTenant)).toBe(false);
      expect(isTrustedDomain(otherTenant.url)).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isAverecuraHoldingAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAverecuraHoldingAgJob(null)).toBe(false);
      expect(isAverecuraHoldingAgJob(undefined)).toBe(false);
      expect(isAverecuraHoldingAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts only the averecura tenant path on the primary host', () => {
      expect(isTrustedDomain('https://app.reflinejobs.io/3034/0108/careers/job-123')).toBe(true);
    });

    it('allows the tenant path on an app subdomain', () => {
      expect(isTrustedDomain('https://careers.app.reflinejobs.io/3034/0108/job/456')).toBe(true);
    });

    it('rejects the shared host with another tenant path', () => {
      expect(isTrustedDomain('https://app.reflinejobs.io/9999/0108/job/1')).toBe(false);
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
      expect(slugify('Developer averecura-holding-ag ch')).toBe('developer-averecura-holding-ag-ch');
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
      id: 'averecura-holding-ag-abc123',
      slug: 'test-position-averecura-holding-ag-ch',
      slugByLocale: { de: 'test-position-averecura-holding-ag-ch' },
      company: 'averecura holding ag',
      companyKey: 'averecura-holding-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://app.reflinejobs.io/jobs/test',
      source: 'averecura holding ag Dedicated Parser',
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
      expect(validJob.id).toMatch(/^averecura-holding-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
