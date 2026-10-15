import { afterEach, describe, it, expect, vi } from 'vitest';
const specCrawlerMocks = vi.hoisted(() => ({
  loadSpec: vi.fn(),
  runSpecInProduction: vi.fn(),
}));
vi.mock('../scripts/lib/prospector/spec-crawler.mjs', () => specCrawlerMocks);

import {
  GUGGERBACH_KEY,
  GUGGERBACH_COMPANY_NAME,
  fetchAllGuggerbachJobs,
  isGuggerbachJob,
  isTrustedDomain,
} from '../scripts/lib/guggerbach-job-parser.mjs';
import { crawlerStrictEnvVar, slugify } from '../scripts/lib/crawler-template.mjs';

afterEach(() => {
  specCrawlerMocks.loadSpec.mockReset();
  specCrawlerMocks.runSpecInProduction.mockReset();
});

describe('Bistro Guggerzyt crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GUGGERBACH_KEY).toBe('guggerbach');
    expect(GUGGERBACH_COMPANY_NAME).toBe('Bistro Guggerzyt');
  });

  // ── isCompanyJob ──
  describe('isGuggerbachJob', () => {
    it('matches by companyKey', () => {
      expect(isGuggerbachJob({ companyKey: 'guggerbach' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGuggerbachJob({ company: 'Bistro Guggerzyt' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGuggerbachJob({ url: 'https://guggerbach.ch/jobs/123' })).toBe(true);
    });

    it('does not match the domain when it appears only in a query or path', () => {
      expect(isGuggerbachJob({ companyKey: 'other-company', company: 'Other', url: 'https://example.com/?next=guggerbach.ch' }))
        .toBe(false);
      expect(isGuggerbachJob({ companyKey: 'other-company', company: 'Other', url: 'https://example.com/jobs/guggerbach.ch' }))
        .toBe(false);
      expect(isGuggerbachJob({ url: 'https://careers.guggerbach.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGuggerbachJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGuggerbachJob(null)).toBe(false);
      expect(isGuggerbachJob(undefined)).toBe(false);
      expect(isGuggerbachJob({})).toBe(false);
    });
  });

  describe('fetchAllGuggerbachJobs', () => {
    it('fails explicitly when every listing lacks a usable Swiss location', async () => {
      specCrawlerMocks.loadSpec.mockReturnValue({ companyKey: GUGGERBACH_KEY });
      specCrawlerMocks.runSpecInProduction.mockResolvedValue([
        { title: 'Servicefachkraft', description: '<p>Aufgabe</p>', url: 'https://guggerbach.ch/jobs/1' },
        { title: 'Koch', description: '<p>Aufgabe</p>', url: 'https://guggerbach.ch/jobs/2' },
      ]);

      await expect(fetchAllGuggerbachJobs())
        .rejects.toThrow('all 2 listings lack a usable Swiss location');
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://guggerbach.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.guggerbach.ch/job/456')).toBe(true);
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
      expect(slugify('Developer guggerbach ch')).toBe('developer-guggerbach-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  describe('strict validation environment', () => {
    it('maps single- and multi-word crawler keys to shell-safe names', () => {
      expect(crawlerStrictEnvVar(GUGGERBACH_KEY)).toBe('JOBS_GUGGERBACH_STRICT');
      expect(crawlerStrictEnvVar('guggerbach-bistro')).toBe('JOBS_GUGGERBACH_BISTRO_STRICT');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'guggerbach-abc123',
      slug: 'test-position-guggerbach-ch',
      slugByLocale: { de: 'test-position-guggerbach-ch' },
      company: 'Bistro Guggerzyt',
      companyKey: 'guggerbach',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://guggerbach.ch/jobs/test',
      source: 'Bistro Guggerzyt Dedicated Parser',
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
      expect(validJob.id).toMatch(/^guggerbach-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
