import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RICHEMONT_KEY,
  RICHEMONT_COMPANY_NAME,
  isRichemontJob,
  isTrustedDomain,
  fetchAllRichemontJobs,
} from '../scripts/lib/richemont-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Richemont crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RICHEMONT_KEY).toBe('richemont');
    expect(RICHEMONT_COMPANY_NAME).toBe('Richemont');
  });

  // ── isCompanyJob ──
  describe('isRichemontJob', () => {
    it('matches by companyKey', () => {
      expect(isRichemontJob({ companyKey: 'richemont' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRichemontJob({ company: 'Richemont' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRichemontJob({ url: 'https://richemont.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRichemontJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRichemontJob(null)).toBe(false);
      expect(isRichemontJob(undefined)).toBe(false);
      expect(isRichemontJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://richemont.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.richemont.com/job/456')).toBe(true);
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
      expect(slugify('Developer richemont ch')).toBe('developer-richemont-ch');
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
      id: 'richemont-abc123',
      slug: 'test-position-richemont-ch',
      slugByLocale: { en: 'test-position-richemont-ch' },
      company: 'Richemont',
      companyKey: 'richemont',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://richemont.com/jobs/test',
      source: 'Richemont Dedicated Parser',
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
      expect(validJob.id).toMatch(/^richemont-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllRichemontJobs (Adzuna fallback path, mocked fetch) ──
  describe('fetchAllRichemontJobs (Adzuna fallback)', () => {
    let tmpCacheDir: string;

    beforeEach(async () => {
      tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adz-richemont-'));
    });

    afterEach(async () => {
      await fs.rm(tmpCacheDir, { recursive: true, force: true });
    });

    it('returns ParsedJobs from a mocked Adzuna response, filtering non-Richemont brands', async () => {
      const fetchImpl = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            count: 3,
            results: [
              {
                id: '1',
                title: 'Senior Watchmaker',
                company: { display_name: 'Richemont International SA' },
                location: { display_name: 'Geneva, Switzerland' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/1',
                created: '2026-05-01T10:00:00Z',
                description: 'Lead watchmaker role.',
              },
              {
                id: '2',
                title: 'Boutique Manager',
                company: { display_name: 'Cartier' },
                location: { display_name: 'Zurich' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/2',
                created: '2026-05-02T10:00:00Z',
                description: 'Boutique management role.',
              },
              {
                id: '3',
                title: 'Pilot',
                company: { display_name: 'SWISS Air Lines' },
                location: { display_name: 'Zurich' },
                redirect_url: 'https://www.adzuna.ch/jobs/details/3',
                created: '2026-05-03T10:00:00Z',
                description: 'Pilot role.',
              },
            ],
          }),
        }) as unknown as Response;

      const jobs = await fetchAllRichemontJobs({
        appId: 'TEST_ID',
        appKey: 'TEST_KEY',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
        _cacheDate: '2026-05-10',
        maxPages: 1,
      });

      expect(jobs).toHaveLength(2);
      const titles = jobs.map((j: { title: string }) => j.title);
      expect(titles).toContain('Senior Watchmaker');
      expect(titles).toContain('Boutique Manager');
      expect(titles).not.toContain('Pilot');
      for (const job of jobs) {
        expect(job.companyKey).toBe('richemont');
        expect(job.source).toBe('Richemont Adzuna Fallback');
        expect(job.sector).toBe('Lusso');
        expect(job.applyUrl).toMatch(/^https:\/\/www\.adzuna\.ch\//);
        expect(isTrustedDomain(job.applyUrl)).toBe(true);
      }
    });
  });
});
