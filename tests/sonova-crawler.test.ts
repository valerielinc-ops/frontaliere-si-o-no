import { describe, it, expect } from 'vitest';
import {
  SONOVA_KEY,
  SONOVA_COMPANY_NAME,
  isSonovaJob,
  isTrustedDomain,
} from '../scripts/lib/sonova-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Sonova crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SONOVA_KEY).toBe('sonova');
    expect(SONOVA_COMPANY_NAME).toBe('Sonova');
  });

  // ── isCompanyJob ──
  describe('isSonovaJob', () => {
    it('matches by companyKey', () => {
      expect(isSonovaJob({ companyKey: 'sonova' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSonovaJob({ company: 'Sonova' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSonovaJob({ url: 'https://sonova.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSonovaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSonovaJob(null)).toBe(false);
      expect(isSonovaJob(undefined)).toBe(false);
      expect(isSonovaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sonova.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.sonova.com/job/456')).toBe(true);
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
      expect(slugify('Developer sonova ch')).toBe('developer-sonova-ch');
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
      id: 'sonova-abc123',
      slug: 'test-position-sonova-ch',
      slugByLocale: { de: 'test-position-sonova-ch' },
      company: 'Sonova',
      companyKey: 'sonova',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://sonova.com/jobs/test',
      source: 'Sonova Dedicated Parser',
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
      expect(validJob.id).toMatch(/^sonova-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
