import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  BLATTERS_HOTEL_KEY,
  BLATTERS_HOTEL_COMPANY_NAME,
  fetchAllBlattersHotelJobs,
  fetchJobListings,
  isBlattersHotelJob,
  isTrustedDomain,
} from '../scripts/lib/blatters-hotel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  isAuthoritativeEmptySnapshot,
  markAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';

function response(url: string, status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe("Blatter's Arosa Hotel crawler parser", () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BLATTERS_HOTEL_KEY).toBe('blatters-hotel');
    expect(BLATTERS_HOTEL_COMPANY_NAME).toBe('Blatter');
  });

  // ── isCompanyJob ──
  describe('isBlattersHotelJob', () => {
    it('matches by companyKey', () => {
      expect(isBlattersHotelJob({ companyKey: 'blatters-hotel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBlattersHotelJob({ company: "Blatter's Arosa Hotel" })).toBe(true);
    });

    it('matches by HotelCareer company URL', () => {
      expect(isBlattersHotelJob({ url: 'https://hotelcareer.ch/jobs/blatter-s-hotel-arosa-4340/123' })).toBe(true);
    });

    it('rejects unrelated HotelCareer listings', () => {
      expect(isBlattersHotelJob({ url: 'https://hotelcareer.ch/jobs/romantik-hotel-schweizerhof-11933/123' })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isBlattersHotelJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBlattersHotelJob(null)).toBe(false);
      expect(isBlattersHotelJob(undefined)).toBe(false);
      expect(isBlattersHotelJob({})).toBe(false);
    });
  });

  // ── Source-proven zero (same Hotelcareer employer page as vereinaklosters) ──
  describe('source-proven zero', () => {
    it('passes a proven employer-page zero through to the pipeline', async () => {
      const proven = markAuthoritativeEmptySnapshot([], 'Hotelcareer employer page: no vacancy');
      const jobs = await fetchAllBlattersHotelJobs({ fetchListings: async () => proven });
      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    });

    it('never turns a page that lists a vacancy into a zero, even when its detail is unreadable', async () => {
      // Real employer page (2026-10-01) with its one vacancy; the detail page
      // answers 403 and the clean-IP rescue is challenged too.
      const page = fs.readFileSync(
        new URL('./fixtures/hotelcareer/blatter-s-hotel-arosa-4340-one-vacancy.html', import.meta.url),
        'utf8',
      );
      const seed = 'https://www.hotelcareer.ch/jobs/blatter-s-hotel-arosa-4340?intcid=autosuggest-company-4340';
      const challenge = '<html><head><title>Challenge Validation</title></head><body>blocked</body></html>';
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.endsWith('/robots.txt')) return response(url, 200, 'User-agent: *\nAllow: /');
        if (url === seed) return response(url, 200, page);
        return response(url, 403, challenge);
      });
      const listings = await fetchJobListings({
        spec: {
          companyKey: 'blatters-hotel', companyName: "Blatter's Arosa Hotel", companyHost: 'hotelcareer.ch',
          platform: 'hotelcareer.ch', mode: 'template', seedUrls: [seed],
          detailTemplate: '/jobs/blatter-s-hotel-arosa-4340/*', detailEnrichment: true,
        } as any,
        runtime: {
          fetchImpl,
          jinaFetchImpl: vi.fn(async (url: string) => response(url, 200, challenge)),
          lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
          retries: 0,
          jinaRetries: 0,
          sleepImpl: async () => {},
          jinaSleepImpl: async () => {},
        },
      });

      expect(listings).toEqual([]);
      expect(isAuthoritativeEmptySnapshot(listings)).toBe(false);
    });

    it('asks the pipeline for the source-proven zero', () => {
      const runner = fs.readFileSync(new URL('../scripts/update-blatters-hotel-jobs.mjs', import.meta.url), 'utf8');
      expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(');
      expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
      expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hotelcareer.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hotelcareer.ch/job/456')).toBe(true);
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
      expect(slugify('Developer blatters-hotel ch')).toBe('developer-blatters-hotel-ch');
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
      id: 'blatters-hotel-abc123',
      slug: 'test-position-blatters-hotel-ch',
      slugByLocale: { de: 'test-position-blatters-hotel-ch' },
      company: 'Blatter',
      companyKey: 'blatters-hotel',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hotelcareer.ch/jobs/test',
      source: "Blatter's Arosa Hotel Dedicated Parser",
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
      expect(validJob.id).toMatch(/^blatters-hotel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
