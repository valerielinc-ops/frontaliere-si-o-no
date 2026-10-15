import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  LIVIT_KEY,
  LIVIT_COMPANY_NAME,
  isLivitJob,
  isTrustedDomain,
  fetchAllLivitJobs,
} from '../scripts/lib/livit-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1006570/jobs';

describe('Livit AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(LIVIT_KEY).toBe('livit');
    expect(LIVIT_COMPANY_NAME).toBe('Livit AG');
  });

  // ── isCompanyJob ──
  describe('isLivitJob', () => {
    it('matches by companyKey', () => {
      expect(isLivitJob({ companyKey: 'livit' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isLivitJob({ company: 'Livit AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isLivitJob({ url: 'https://jobs.livit.ch/offene-stellen/bewirtschafter-in/abc' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isLivitJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isLivitJob(null)).toBe(false);
      expect(isLivitJob(undefined)).toBe(false);
      expect(isLivitJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the dedicated careercenter domain', () => {
      expect(isTrustedDomain('https://jobs.livit.ch/offene-stellen/bewirtschafter-in/abc')).toBe(true);
    });

    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://livit.ch/careers')).toBe(true);
    });

    it('trusts the Prospective medium-scoped host', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/medium/1006570/jobs/xyz')).toBe(true);
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
      const slug = slugify('Immobilienbewirtschafter:in (m/w/d)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Gérant/e d’immeubles')).toBe('gerant-e-d-immeubles');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'livit-abc123',
      slug: 'test-position-livit-zuerich',
      slugByLocale: { de: 'test-position-livit-zuerich' },
      company: 'Livit AG',
      companyKey: 'livit',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://jobs.livit.ch/offene-stellen/test-position/abc',
      source: 'Livit AG Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      postalCode: '8005',
      streetAddress: 'Aargauerstrasse 1',
      employmentType: 'FULL_TIME',
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
        'postalCode', 'streetAddress', 'employmentType',
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
      expect(validJob.id).toMatch(/^livit-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllLivitJobs (graceful degradation + Prospective contract) ──
  describe('fetchAllLivitJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      // Skip the real exponential backoff (1s/2s/4s) fetchWithRetry does on
      // retryable statuses — several tests below deliberately return 500/503
      // to exercise graceful degradation, and don't need the real delay.
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 500 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND ohws.prospective.ch');
      }) as any;

      const jobs = await fetchAllLivitJobs();
      expect(jobs).toEqual([]);
    });

    it('parses listings when the Prospective API returns jobs', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(API_URL)) {
          return new Response(
            JSON.stringify({
              total: 1,
              jobs: [
                {
                  szas: {
                    sza_title: 'Immobilienbewirtschafter:in',
                    'sza_location.city': '8005 Zürich',
                  },
                  links: {
                    directlink: 'https://jobs.livit.ch/offene-stellen/immobilienbewirtschafter-in/f4f77692',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllLivitJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Livit AG',
        companyKey: 'livit',
        canton: 'ZH',
        country: 'CH',
      });
      expect(jobs[0].url).toBe(
        'https://jobs.livit.ch/offene-stellen/immobilienbewirtschafter-in/f4f77692',
      );
      expect(jobs[0].id).toMatch(/^livit-/);
      expect(jobs[0].postalCode).toBe('8005');
    });

    it('returns [] (no throw) when the Prospective API errors mid-pagination', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 503 });
      }) as any;

      const jobs = await fetchAllLivitJobs();
      expect(jobs).toEqual([]);
    });
  });
});
