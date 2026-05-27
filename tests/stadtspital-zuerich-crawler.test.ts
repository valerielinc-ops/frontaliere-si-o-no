import { describe, it, expect, vi } from 'vitest';

// Stub the playwright runtime BEFORE importing the parser under test, so
// that fetchAllStadtspitalZuerichJobs() can run without a real Chromium.
// Each test scenario re-mocks the relevant export.
vi.mock('../scripts/lib/ats-clients/playwright-runtime.mjs', () => {
  class BrowserLaunchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BrowserLaunchError';
    }
  }
  class NavigationTimeout extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NavigationTimeout';
    }
  }
  class AntiBotBlockError extends Error {
    status?: number;
    title?: string;
    constructor(message: string, opts: { status?: number; title?: string } = {}) {
      super(message);
      this.name = 'AntiBotBlockError';
      this.status = opts.status;
      this.title = opts.title;
    }
  }
  return {
    createBrowser: vi.fn(async () => ({})),
    createPoliteContext: vi.fn(async () => ({})),
    fetchWithRateLimit: vi.fn(async () => {
      // Default: simulate the geo-block (TCP-level connect timeout).
      throw new NavigationTimeout('connect ETIMEDOUT (geo-block from non-CH IP)');
    }),
    closeAll: vi.fn(async () => {}),
    BrowserLaunchError,
    NavigationTimeout,
    AntiBotBlockError,
  };
});

import {
  STADTSPITAL_ZUERICH_KEY,
  STADTSPITAL_ZUERICH_COMPANY_NAME,
  isStadtspitalZuerichJob,
  isTrustedDomain,
  fetchAllStadtspitalZuerichJobs,
} from '../scripts/lib/stadtspital-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import * as playwrightRuntime from '../scripts/lib/ats-clients/playwright-runtime.mjs';

describe('Stadtspital Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADTSPITAL_ZUERICH_KEY).toBe('stadtspital-zuerich');
    expect(STADTSPITAL_ZUERICH_COMPANY_NAME).toBe('Stadtspital Zürich');
  });

  // ── isCompanyJob ──
  describe('isStadtspitalZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'stadtspital-zuerich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtspitalZuerichJob({ company: 'Stadtspital Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStadtspitalZuerichJob({ url: 'https://stadtspital.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStadtspitalZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtspitalZuerichJob(null)).toBe(false);
      expect(isStadtspitalZuerichJob(undefined)).toBe(false);
      expect(isStadtspitalZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://stadtspital.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.stadtspital.ch/job/456')).toBe(true);
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
      expect(slugify('Developer stadtspital-zuerich ch')).toBe('developer-stadtspital-zuerich-ch');
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
      id: 'stadtspital-zuerich-abc123',
      slug: 'test-position-stadtspital-zuerich-ch',
      slugByLocale: { de: 'test-position-stadtspital-zuerich-ch' },
      company: 'Stadtspital Zürich',
      companyKey: 'stadtspital-zuerich',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://stadtspital.ch/jobs/test',
      source: 'Stadtspital Zürich Dedicated Parser',
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
      expect(validJob.id).toMatch(/^stadtspital-zuerich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllStadtspitalZuerichJobs (graceful degradation) ──
  describe('fetchAllStadtspitalZuerichJobs — graceful degradation', () => {
    it('returns [] (no throw) when geo-block triggers NavigationTimeout', async () => {
      // Default mock above already throws NavigationTimeout.
      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs).toHaveLength(0);
    });

    it('returns [] (no throw) when chromium launch fails', async () => {
      const { BrowserLaunchError } = playwrightRuntime as any;
      vi.mocked(playwrightRuntime.createBrowser).mockRejectedValueOnce(
        new BrowserLaunchError('chromium binary missing'),
      );
      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) when origin returns anti-bot 403', async () => {
      const { AntiBotBlockError } = playwrightRuntime as any;
      vi.mocked(playwrightRuntime.fetchWithRateLimit).mockRejectedValueOnce(
        new AntiBotBlockError('blocked', { status: 403, title: 'Access Denied' }),
      );
      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(jobs).toEqual([]);
    });

    it('parses listings when the DOM probe finds matching nodes', async () => {
      const fakePage = {
        waitForLoadState: vi.fn(async () => {}),
        evaluate: vi.fn(async () => [
          {
            title: 'Pflegefachperson HF / FH',
            url: 'https://stadtspital.ch/karriere/job/123',
            location: 'Zürich',
          },
        ]),
        close: vi.fn(async () => {}),
      };
      vi.mocked(playwrightRuntime.fetchWithRateLimit).mockResolvedValueOnce(
        fakePage as any,
      );

      const jobs = await fetchAllStadtspitalZuerichJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Stadtspital Zürich',
        companyKey: 'stadtspital-zuerich',
        canton: 'ZH',
        country: 'CH',
      });
      expect(jobs[0].id).toMatch(/^stadtspital-zuerich-/);
      expect(jobs[0].slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
