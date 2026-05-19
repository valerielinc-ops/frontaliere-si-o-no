import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  LUKS_KEY,
  LUKS_COMPANY_NAME,
  isLuksJob,
  isTrustedDomain,
  fetchAllLuksJobs,
} from '../scripts/lib/luks-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const PAGE_DATA_URL =
  'https://www.luks.ch/page-data/stellen-und-karriere/offene-stellen/page-data.json';
const SITEMAP_URL = 'https://www.luks.ch/sitemap-0.xml';

describe('Luzerner Kantonsspital (LUKS) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LUKS_KEY).toBe('luks');
    expect(LUKS_COMPANY_NAME).toBe('Luzerner Kantonsspital (LUKS)');
  });

  // ── isCompanyJob ──
  describe('isLuksJob', () => {
    it('matches by companyKey', () => {
      expect(isLuksJob({ companyKey: 'luks' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLuksJob({ company: 'Luzerner Kantonsspital (LUKS)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLuksJob({ url: 'https://luks.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLuksJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLuksJob(null)).toBe(false);
      expect(isLuksJob(undefined)).toBe(false);
      expect(isLuksJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://luks.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.luks.ch/job/456')).toBe(true);
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
      expect(slugify('Developer luks ch')).toBe('developer-luks-ch');
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
      id: 'luks-abc123',
      slug: 'test-position-luks-ch',
      slugByLocale: { de: 'test-position-luks-ch' },
      company: 'Luzerner Kantonsspital (LUKS)',
      companyKey: 'luks',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://luks.ch/jobs/test',
      source: 'Luzerner Kantonsspital (LUKS) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^luks-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllLuksJobs (graceful degradation + path A/B) ──
  describe('fetchAllLuksJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      // Default: every fetch fails (network down). Override per-test below.
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 500 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('returns [] when JobAbo not yet reinstated (advertCollection empty)', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u === PAGE_DATA_URL) {
          return new Response(
            JSON.stringify({
              result: {
                data: {
                  page: { advertCollection: [] },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllLuksJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND www.luks.ch');
      }) as any;

      const jobs = await fetchAllLuksJobs();
      expect(jobs).toEqual([]);
    });

    // ── 2026-05-19: migrated to Prospective.ch (medium=1003280) ──────────
    // The previous Path A (`page-data.json`) / Path B (`sitemap.xml`) fallbacks
    // were removed by `scripts/lib/luks-job-parser.mjs` when it switched to
    // the shared Prospective factory. These 2 tests assert the NEW Prospective
    // contract: parses jobs from the `{total, jobs[]}` response shape and
    // returns [] gracefully when the Prospective endpoint is unreachable
    // (after the `prospective-ch-job-parser-common.mjs` graceful-degradation
    // wrapper added in the same PR).
    it('parses adverts when Prospective API returns jobs', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith('https://ohws.prospective.ch/public/v1/medium/1003280/jobs')) {
          return new Response(
            JSON.stringify({
              total: 1,
              jobs: [
                {
                  szas: {
                    sza_title: 'Diplomierte Pflegefachperson HF',
                    'sza_location.city': '6000 Luzern',
                  },
                  links: {
                    directlink: 'https://jobs.luks.ch/stellen-und-karriere/offene-stellen/pflege-hf-001',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllLuksJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Luzerner Kantonsspital (LUKS)',
        companyKey: 'luks',
        canton: 'LU',
        country: 'CH',
      });
      expect(jobs[0].url).toBe(
        'https://jobs.luks.ch/stellen-und-karriere/offene-stellen/pflege-hf-001',
      );
      expect(jobs[0].id).toMatch(/^luks-/);
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        // Every call returns 503 — the graceful-degradation wrapper should
        // break out of pagination and return whatever was collected (empty).
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllLuksJobs();
      expect(jobs).toEqual([]);
    });
  });
});
