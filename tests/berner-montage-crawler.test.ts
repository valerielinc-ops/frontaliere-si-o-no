import { describe, it, expect } from 'vitest';
import {
  BERNER_MONTAGE_KEY,
  BERNER_MONTAGE_COMPANY_NAME,
  isBernerMontageJob,
  isTrustedDomain,
} from '../scripts/lib/berner-montage-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Montagetechnik BERNER AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BERNER_MONTAGE_KEY).toBe('berner-montage');
    expect(BERNER_MONTAGE_COMPANY_NAME).toBe('Montagetechnik BERNER AG');
  });

  // ── isCompanyJob ──
  describe('isBernerMontageJob', () => {
    it('matches by companyKey', () => {
      expect(isBernerMontageJob({ companyKey: 'berner-montage' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBernerMontageJob({ company: 'Montagetechnik BERNER AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBernerMontageJob({ url: 'https://berner.eu/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBernerMontageJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBernerMontageJob(null)).toBe(false);
      expect(isBernerMontageJob(undefined)).toBe(false);
      expect(isBernerMontageJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://berner.eu/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.berner.eu/job/456')).toBe(true);
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
      expect(slugify('Developer berner-montage ch')).toBe('developer-berner-montage-ch');
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
      id: 'berner-montage-abc123',
      slug: 'test-position-berner-montage-ch',
      slugByLocale: { de: 'test-position-berner-montage-ch' },
      company: 'Montagetechnik BERNER AG',
      companyKey: 'berner-montage',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://berner.eu/jobs/test',
      source: 'Montagetechnik BERNER AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^berner-montage-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
