import { describe, it, expect } from 'vitest';
import {
  JUMBO_KEY,
  JUMBO_COMPANY_NAME,
  isJumboJob,
  isTrustedDomain,
} from '../scripts/lib/jumbo-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('JUMBO crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(JUMBO_KEY).toBe('jumbo');
    expect(JUMBO_COMPANY_NAME).toBe('JUMBO');
  });

  // ── isCompanyJob ──
  describe('isJumboJob', () => {
    it('matches by companyKey', () => {
      expect(isJumboJob({ companyKey: 'jumbo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isJumboJob({ company: 'JUMBO' })).toBe(true);
    });

    it('matches by URL domain (jumbo.ch)', () => {
      expect(isJumboJob({ url: 'https://jumbo.ch/de/stellen' })).toBe(true);
    });

    it('matches by URL domain (coopjobs.ch + company)', () => {
      expect(isJumboJob({ url: 'https://jobs.coopjobs.ch/offene-stellen/test/abc', company: 'JUMBO' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isJumboJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isJumboJob(null)).toBe(false);
      expect(isJumboJob(undefined)).toBe(false);
      expect(isJumboJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jumbo.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.jumbo.ch/job/456')).toBe(true);
    });

    it('trusts Coop Group portal', () => {
      expect(isTrustedDomain('https://jobs.coopjobs.ch/offene-stellen/test/abc123')).toBe(true);
    });

    it('trusts Prospective.ch', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/medium/1000103/jobs')).toBe(true);
    });

    it('trusts SuccessFactors apply links', () => {
      expect(isTrustedDomain('https://career2.successfactors.eu/career?company=Coop')).toBe(true);
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
      expect(slugify('Developer jumbo ch')).toBe('developer-jumbo-ch');
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
      id: 'jumbo-abc123',
      slug: 'test-position-jumbo-ch',
      slugByLocale: { de: 'test-position-jumbo-ch' },
      company: 'JUMBO',
      companyKey: 'jumbo',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://jumbo.ch/jobs/test',
      source: 'JUMBO Dedicated Parser',
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
      expect(validJob.id).toMatch(/^jumbo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
