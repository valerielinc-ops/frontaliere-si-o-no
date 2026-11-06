import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  BUEHLER_KEY,
  BUEHLER_COMPANY_NAME,
  fetchAllBuehlerJobs,
  isBuehlerJob,
  isTrustedDomain,
} from '../scripts/lib/buehler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Captured Prospective feed of medium 1008005 (2026-09-25), trimmed to the
// title/location fields: 154 listings, of which 22 are in Uzwil and 132 at the
// group's foreign sites (Alzenau, Wuxi, Plymouth MN, Makati City, …).
const FEED = JSON.parse(readFileSync(
  path.resolve(process.cwd(), 'tests/fixtures/buehler-prospective-jobs.json'),
  'utf8',
));

describe('Bühler Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BUEHLER_KEY).toBe('buehler');
    expect(BUEHLER_COMPANY_NAME).toBe('Bühler Group');
  });

  // ── isCompanyJob ──
  describe('isBuehlerJob', () => {
    it('matches by companyKey', () => {
      expect(isBuehlerJob({ companyKey: 'buehler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBuehlerJob({ company: 'Bühler Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBuehlerJob({ url: 'https://buhlergroup.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBuehlerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBuehlerJob(null)).toBe(false);
      expect(isBuehlerJob(undefined)).toBe(false);
      expect(isBuehlerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://buhlergroup.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.buhlergroup.com/job/456')).toBe(true);
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
      expect(slugify('Developer buehler ch')).toBe('developer-buehler-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Replay of the captured feed (issue 9844) ──
  describe('fetchAllBuehlerJobs — replay of the captured Prospective feed', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('keeps the Uzwil listings and drops every foreign site instead of publishing it as SG', async () => {
      vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
        const url = new URL(rawUrl);
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: FEED.total, jobs: FEED.jobs.slice(offset, offset + limit) }),
        };
      }));

      const jobs = await fetchAllBuehlerJobs();
      const swiss = FEED.jobs.filter((listing: { szas: Record<string, string> }) => (
        listing.szas['sza_workplace.city'] === 'Uzwil'
      ));

      expect(FEED.jobs).toHaveLength(154);
      expect(swiss).toHaveLength(22);
      expect(jobs).toHaveLength(swiss.length);
      expect(new Set(jobs.map((job: { url: string }) => job.url)))
        .toEqual(new Set(swiss.map((listing: { links: { directlink: string } }) => listing.links.directlink)));
      for (const job of jobs) {
        expect(job).toMatchObject({ location: 'Uzwil', canton: 'SG', addressCountry: 'CH', postalCode: '9240' });
      }
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'buehler-abc123',
      slug: 'test-position-buehler-ch',
      slugByLocale: { de: 'test-position-buehler-ch' },
      company: 'Bühler Group',
      companyKey: 'buehler',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://buhlergroup.com/jobs/test',
      source: 'Bühler Group Dedicated Parser',
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
      expect(validJob.id).toMatch(/^buehler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
