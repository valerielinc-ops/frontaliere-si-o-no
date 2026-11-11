import { describe, it, expect } from 'vitest';
import {
  PROPLANING_AG_KEY,
  PROPLANING_AG_COMPANY_NAME,
  isProplaningAgJob,
  isTrustedDomain,
} from '../scripts/lib/proplaning-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Proplaning AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PROPLANING_AG_KEY).toBe('proplaning-ag');
    expect(PROPLANING_AG_COMPANY_NAME).toBe('Proplaning AG');
  });

  // ── isCompanyJob ──
  describe('isProplaningAgJob', () => {
    it('matches by companyKey', () => {
      expect(isProplaningAgJob({ companyKey: 'proplaning-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isProplaningAgJob({ company: 'Proplaning AG' })).toBe(true);
    });

    it('matches by Proplaning tenant path on the shared Jobalino host', () => {
      expect(isProplaningAgJob({
        url: 'https://my.jobalino.ch/job/abc/proplaning-ag/role',
      })).toBe(true);
    });

    it('rejects another Jobalino employer even when the host is shared', () => {
      expect(isProplaningAgJob({
        companyKey: 'other-employer',
        company: 'Other Employer',
        url: 'https://my.jobalino.ch/job/abc/other-employer/role',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isProplaningAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isProplaningAgJob(null)).toBe(false);
      expect(isProplaningAgJob(undefined)).toBe(false);
      expect(isProplaningAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://my.jobalino.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.my.jobalino.ch/job/456')).toBe(true);
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
      expect(slugify('Developer proplaning-ag ch')).toBe('developer-proplaning-ag-ch');
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
      id: 'proplaning-ag-abc123',
      slug: 'test-position-proplaning-ag-ch',
      slugByLocale: { de: 'test-position-proplaning-ag-ch' },
      company: 'Proplaning AG',
      companyKey: 'proplaning-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://my.jobalino.ch/jobs/test',
      source: 'Proplaning AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^proplaning-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
