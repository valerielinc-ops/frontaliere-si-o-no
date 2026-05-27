import { describe, it, expect } from 'vitest';
import {
  SRG_SSR_KEY,
  SRG_SSR_COMPANY_NAME,
  isSrgSsrJob,
  isTrustedDomain,
} from '../scripts/lib/srg-ssr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SRG SSR crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SRG_SSR_KEY).toBe('srg-ssr');
    expect(SRG_SSR_COMPANY_NAME).toBe('SRG SSR');
  });

  // ── isCompanyJob ──
  describe('isSrgSsrJob', () => {
    it('matches by companyKey', () => {
      expect(isSrgSsrJob({ companyKey: 'srg-ssr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSrgSsrJob({ company: 'SRG SSR' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSrgSsrJob({ url: 'https://srgssr.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSrgSsrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSrgSsrJob(null)).toBe(false);
      expect(isSrgSsrJob(undefined)).toBe(false);
      expect(isSrgSsrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://srgssr.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.srgssr.ch/job/456')).toBe(true);
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
      expect(slugify('Developer srg-ssr ch')).toBe('developer-srg-ssr-ch');
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
      id: 'srg-ssr-abc123',
      slug: 'test-position-srg-ssr-ch',
      slugByLocale: { de: 'test-position-srg-ssr-ch' },
      company: 'SRG SSR',
      companyKey: 'srg-ssr',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://srgssr.ch/jobs/test',
      source: 'SRG SSR Dedicated Parser',
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
      expect(validJob.id).toMatch(/^srg-ssr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
