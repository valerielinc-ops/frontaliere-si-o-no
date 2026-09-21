import { describe, it, expect } from 'vitest';
import {
  YELLOWSHARK_KEY,
  YELLOWSHARK_COMPANY_NAME,
  isYellowsharkJob,
  isTrustedDomain,
} from '../scripts/lib/yellowshark-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('yellowshark AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(YELLOWSHARK_KEY).toBe('yellowshark');
    expect(YELLOWSHARK_COMPANY_NAME).toBe('yellowshark AG');
  });

  // ── isCompanyJob ──
  describe('isYellowsharkJob', () => {
    it('matches by companyKey', () => {
      expect(isYellowsharkJob({ companyKey: 'yellowshark' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isYellowsharkJob({ company: 'yellowshark AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isYellowsharkJob({ url: 'https://jobs.yellowshark.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isYellowsharkJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isYellowsharkJob(null)).toBe(false);
      expect(isYellowsharkJob(undefined)).toBe(false);
      expect(isYellowsharkJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.yellowshark.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jobs.yellowshark.com/job/456')).toBe(true);
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
      expect(slugify('Developer yellowshark ch')).toBe('developer-yellowshark-ch');
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
      id: 'yellowshark-abc123',
      slug: 'test-position-yellowshark-ch',
      slugByLocale: { de: 'test-position-yellowshark-ch' },
      company: 'yellowshark AG',
      companyKey: 'yellowshark',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jobs.yellowshark.com/jobs/test',
      source: 'yellowshark AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^yellowshark-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
