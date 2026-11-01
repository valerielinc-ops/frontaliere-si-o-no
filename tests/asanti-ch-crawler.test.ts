import { describe, it, expect } from 'vitest';
import {
  ASANTI_CH_KEY,
  ASANTI_CH_COMPANY_NAME,
  isAsantiChJob,
  isTrustedDomain,
} from '../scripts/lib/asanti-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Asanti AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ASANTI_CH_KEY).toBe('asanti-ch');
    expect(ASANTI_CH_COMPANY_NAME).toBe('Asanti AG');
  });

  // ── isCompanyJob ──
  describe('isAsantiChJob', () => {
    it('matches by companyKey', () => {
      expect(isAsantiChJob({ companyKey: 'asanti-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAsantiChJob({ company: 'Asanti AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAsantiChJob({ url: 'https://asanti.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAsantiChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAsantiChJob(null)).toBe(false);
      expect(isAsantiChJob(undefined)).toBe(false);
      expect(isAsantiChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://asanti.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.asanti.ch/job/456')).toBe(true);
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
      expect(slugify('Developer asanti-ch ch')).toBe('developer-asanti-ch-ch');
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
      id: 'asanti-ch-abc123',
      slug: 'test-position-asanti-ch-ch',
      slugByLocale: { de: 'test-position-asanti-ch-ch' },
      company: 'Asanti AG',
      companyKey: 'asanti-ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://asanti.ch/jobs/test',
      source: 'Asanti AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^asanti-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
