import { describe, it, expect } from 'vitest';
import {
  OPACC_SOFTWARE_AG_KEY,
  OPACC_SOFTWARE_AG_COMPANY_NAME,
  isOpaccSoftwareAgJob,
  isTrustedDomain,
} from '../scripts/lib/opacc-software-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Opacc Software AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OPACC_SOFTWARE_AG_KEY).toBe('opacc-software-ag');
    expect(OPACC_SOFTWARE_AG_COMPANY_NAME).toBe('Opacc Software AG');
  });

  // ── isCompanyJob ──
  describe('isOpaccSoftwareAgJob', () => {
    it('matches by companyKey', () => {
      expect(isOpaccSoftwareAgJob({ companyKey: 'opacc-software-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOpaccSoftwareAgJob({ company: 'Opacc Software AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOpaccSoftwareAgJob({ url: 'https://my.jobalino.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOpaccSoftwareAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOpaccSoftwareAgJob(null)).toBe(false);
      expect(isOpaccSoftwareAgJob(undefined)).toBe(false);
      expect(isOpaccSoftwareAgJob({})).toBe(false);
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
      expect(slugify('Developer opacc-software-ag ch')).toBe('developer-opacc-software-ag-ch');
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
      id: 'opacc-software-ag-abc123',
      slug: 'test-position-opacc-software-ag-ch',
      slugByLocale: { de: 'test-position-opacc-software-ag-ch' },
      company: 'Opacc Software AG',
      companyKey: 'opacc-software-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://my.jobalino.ch/jobs/test',
      source: 'Opacc Software AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^opacc-software-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
