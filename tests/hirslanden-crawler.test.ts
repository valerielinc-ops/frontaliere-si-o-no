import { describe, it, expect } from 'vitest';
import {
  HIRSLANDEN_KEY,
  HIRSLANDEN_COMPANY_NAME,
  isHirslandenJob,
  isTrustedDomain,
} from '../scripts/lib/hirslanden-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hirslanden Klinik crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HIRSLANDEN_KEY).toBe('hirslanden');
    expect(HIRSLANDEN_COMPANY_NAME).toBe('Hirslanden Klinik');
  });

  // ── isCompanyJob ──
  describe('isHirslandenJob', () => {
    it('matches by companyKey', () => {
      expect(isHirslandenJob({ companyKey: 'hirslanden' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHirslandenJob({ company: 'Hirslanden Klinik' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHirslandenJob({ url: 'https://hirslanden.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHirslandenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHirslandenJob(null)).toBe(false);
      expect(isHirslandenJob(undefined)).toBe(false);
      expect(isHirslandenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hirslanden.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hirslanden.ch/job/456')).toBe(true);
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
      expect(slugify('Developer hirslanden ch')).toBe('developer-hirslanden-ch');
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
      id: 'hirslanden-abc123',
      slug: 'test-position-hirslanden-ch',
      slugByLocale: { de: 'test-position-hirslanden-ch' },
      company: 'Hirslanden Klinik',
      companyKey: 'hirslanden',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hirslanden.ch/jobs/test',
      source: 'Hirslanden Klinik Dedicated Parser',
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
      expect(validJob.id).toMatch(/^hirslanden-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
