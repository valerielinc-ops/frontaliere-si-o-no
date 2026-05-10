import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MSC_CARGO_KEY,
  MSC_CARGO_COMPANY_NAME,
  isMscCargoJob,
  isTrustedDomain,
  fetchAllMscCargoJobs,
} from '../scripts/lib/msc-cargo-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('MSC Cargo crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MSC_CARGO_KEY).toBe('msc-cargo');
    expect(MSC_CARGO_COMPANY_NAME).toBe('MSC Cargo');
  });

  // ── isCompanyJob ──
  describe('isMscCargoJob', () => {
    it('matches by companyKey', () => {
      expect(isMscCargoJob({ companyKey: 'msc-cargo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMscCargoJob({ company: 'MSC Cargo' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMscCargoJob({ url: 'https://msc.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMscCargoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMscCargoJob(null)).toBe(false);
      expect(isMscCargoJob(undefined)).toBe(false);
      expect(isMscCargoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://msc.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.msc.com/job/456')).toBe(true);
    });

    it('trusts Adzuna domains (fallback aggregator)', () => {
      expect(isTrustedDomain('https://www.adzuna.ch/jobs/details/abc')).toBe(true);
      expect(isTrustedDomain('https://adzuna.com/jobs/details/abc')).toBe(true);
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
      expect(slugify('Developer msc-cargo ch')).toBe('developer-msc-cargo-ch');
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
      id: 'msc-cargo-abc123',
      slug: 'test-position-msc-cargo-ch',
      slugByLocale: { en: 'test-position-msc-cargo-ch' },
      company: 'MSC Cargo',
      companyKey: 'msc-cargo',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://msc.com/jobs/test',
      source: 'MSC Cargo Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^msc-cargo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllMscCargoJobs (Adzuna fallback path, mocked fetch) ──
  describe('fetchAllMscCargoJobs (Adzuna fallback)', () => {
    let tmpCacheDir: string;

    beforeEach(async () => {
      tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adz-msc-'));
    });

    afterEach(async () => {
      await fs.rm(tmpCacheDir, { recursive: true, force: true });
    });

    it('returns ParsedJobs from a mocked Adzuna response, excluding MSC Cruises', async () => {
      const fetchImpl = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            count: 4,
            results: [
              {
                id: '1',
                title: 'Logistics Coordinator',
                company: { display_name: 'MSC Mediterranean Shipping' },
                location: { display_name: 'Geneva' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/1',
                created: '2026-05-01T10:00:00Z',
                description: 'Coordinator role.',
              },
              {
                id: '2',
                title: 'IT Operations Specialist',
                company: { display_name: 'MSC Technology' },
                location: { display_name: 'Geneva' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/2',
                created: '2026-05-02T10:00:00Z',
                description: 'Ops role.',
              },
              {
                id: '3',
                title: 'Cruise Director',
                company: { display_name: 'MSC Cruises' },
                location: { display_name: 'Geneva' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/3',
                created: '2026-05-03T10:00:00Z',
                description: 'Cruise role.',
              },
              {
                id: '4',
                title: 'Sales Lead',
                company: { display_name: 'Some Other Company' },
                location: { display_name: 'Zurich' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/4',
                created: '2026-05-04T10:00:00Z',
                description: 'Sales role.',
              },
            ],
          }),
        }) as unknown as Response;

      const jobs = await fetchAllMscCargoJobs({
        appId: 'TEST_ID',
        appKey: 'TEST_KEY',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
        _cacheDate: '2026-05-10',
        maxPages: 1,
      });

      expect(jobs).toHaveLength(2);
      const titles = jobs.map((j: { title: string }) => j.title);
      expect(titles).toContain('Logistics Coordinator');
      expect(titles).toContain('IT Operations Specialist');
      expect(titles).not.toContain('Cruise Director');
      expect(titles).not.toContain('Sales Lead');
      for (const job of jobs) {
        expect(job.companyKey).toBe('msc-cargo');
        expect(job.source).toBe('MSC Cargo Adzuna Fallback');
        expect(job.sector).toBe('Logistica');
        expect(job.applyUrl).toMatch(/^https:\/\/www\.adzuna\.ch\//);
        expect(isTrustedDomain(job.applyUrl)).toBe(true);
      }
    });
  });
});
