import { describe, it, expect, vi } from 'vitest';
import {
  GIVAUDAN_KEY,
  GIVAUDAN_COMPANY_NAME,
  isGivaudanJob,
  isTrustedDomain,
  fetchAllGivaudanJobs,
  __testables,
} from '../scripts/lib/givaudan-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

/**
 * Build a stubbed Playwright runtime that emulates the surface area of
 * `scripts/lib/ats-clients/playwright-runtime.mjs` consumed by the
 * Givaudan parser. Tests pass the resulting factory through the
 * `_runtime` option so no real browser is launched.
 */
type CardShape = {
  title: string;
  location: string;
  url: string;
  postedDate: string;
};

interface StubPageOptions {
  pages: CardShape[][];
  hasResultsContainer?: boolean;
}

class StubAntiBotBlockError extends Error {
  status?: number;
  title?: string;
  constructor(msg: string, opts: { status?: number; title?: string } = {}) {
    super(msg);
    this.name = 'AntiBotBlockError';
    this.status = opts.status;
    this.title = opts.title;
  }
}

class StubNavigationTimeout extends Error {
  url?: string;
  constructor(msg: string, opts: { url?: string } = {}) {
    super(msg);
    this.name = 'NavigationTimeout';
    this.url = opts.url;
  }
}

class StubBrowserLaunchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BrowserLaunchError';
  }
}

function makeRuntime(opts: StubPageOptions) {
  const pageBatches = opts.pages;
  let pageIdx = 0;
  let loadMoreCalls = 0;

  const loadMoreButton = {
    isVisible: vi.fn(async () => pageIdx < pageBatches.length - 1),
    click: vi.fn(async () => {
      loadMoreCalls += 1;
      pageIdx += 1;
    }),
  };

  const page = {
    waitForSelector: vi.fn(async (selector: string) => {
      if (
        opts.hasResultsContainer === false &&
        selector.includes('ph-page-element-page9-job-results')
      ) {
        throw new Error('selector timeout');
      }
      return null;
    }),
    waitForLoadState: vi.fn(async () => undefined),
    $$eval: vi.fn(async () => pageBatches[pageIdx] || []),
    $: vi.fn(async (selector: string) => {
      if (selector.includes('pagination-load-more') || selector.includes('Load more')) {
        return pageIdx < pageBatches.length - 1 ? loadMoreButton : null;
      }
      return null;
    }),
  };

  return {
    runtime: {
      createBrowser: vi.fn(async () => ({})),
      createPoliteContext: vi.fn(async () => ({})),
      fetchWithRateLimit: vi.fn(async () => page),
      closeAll: vi.fn(async () => undefined),
      AntiBotBlockError: StubAntiBotBlockError,
      NavigationTimeout: StubNavigationTimeout,
      BrowserLaunchError: StubBrowserLaunchError,
    },
    page,
    loadMoreButton,
    getLoadMoreCalls: () => loadMoreCalls,
  };
}

describe('Givaudan crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GIVAUDAN_KEY).toBe('givaudan');
    expect(GIVAUDAN_COMPANY_NAME).toBe('Givaudan');
  });

  // ── isCompanyJob ──
  describe('isGivaudanJob', () => {
    it('matches by companyKey', () => {
      expect(isGivaudanJob({ companyKey: 'givaudan' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGivaudanJob({ company: 'Givaudan' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGivaudanJob({ url: 'https://givaudan.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGivaudanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGivaudanJob(null)).toBe(false);
      expect(isGivaudanJob(undefined)).toBe(false);
      expect(isGivaudanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://givaudan.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.givaudan.com/job/456')).toBe(true);
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
      expect(slugify('Developer givaudan ch')).toBe('developer-givaudan-ch');
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
      id: 'givaudan-abc123',
      slug: 'test-position-givaudan-ch',
      slugByLocale: { en: 'test-position-givaudan-ch' },
      company: 'Givaudan',
      companyKey: 'givaudan',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://givaudan.com/jobs/test',
      source: 'Givaudan Dedicated Parser',
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
      expect(validJob.id).toMatch(/^givaudan-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Phenom People scraper (Playwright path) ──
  describe('fetchJobListings (Phenom Playwright)', () => {
    it('returns Swiss-only cards from a single page of results', async () => {
      const cards: CardShape[] = [
        { title: 'Senior Flavorist', location: 'Vernier, Switzerland', url: '/global/en/job/123/senior-flavorist', postedDate: '2026-05-01' },
        { title: 'Sales Manager', location: 'Paris, France', url: '/global/en/job/124/sales-manager', postedDate: '2026-05-02' },
        { title: 'Process Engineer', location: 'Kemptthal, Switzerland', url: 'https://careers.givaudan.com/global/en/job/125/process-engineer', postedDate: '2026-05-03' },
      ];
      const { runtime } = makeRuntime({ pages: [cards] });

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(out).toHaveLength(2);
      expect(out.map((c) => c.title)).toEqual([
        'Senior Flavorist',
        'Process Engineer',
      ]);
      // Relative URL is resolved to absolute careers.givaudan.com host.
      expect(out[0].url).toBe('https://careers.givaudan.com/global/en/job/123/senior-flavorist');
      expect(out[1].url).toBe('https://careers.givaudan.com/global/en/job/125/process-engineer');
    });

    it('paginates by clicking the Load more button until exhausted', async () => {
      const page1: CardShape[] = [
        { title: 'Job 1', location: 'Vernier, Switzerland', url: '/job/1', postedDate: '' },
      ];
      const page2: CardShape[] = [
        { title: 'Job 1', location: 'Vernier, Switzerland', url: '/job/1', postedDate: '' }, // dup
        { title: 'Job 2', location: 'Genève, Switzerland', url: '/job/2', postedDate: '' },
      ];
      const { runtime, getLoadMoreCalls } = makeRuntime({ pages: [page1, page2] });

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(getLoadMoreCalls()).toBe(1);
      expect(out).toHaveLength(2);
      expect(out.map((c) => c.title).sort()).toEqual(['Job 1', 'Job 2']);
    });

    it('returns [] when results selector never appears (selector drift)', async () => {
      const { runtime } = makeRuntime({ pages: [[]], hasResultsContainer: false });
      // Also fail the fallback selector by overriding the page's waitForSelector.
      runtime.fetchWithRateLimit = vi.fn(async () => ({
        waitForSelector: vi.fn(async () => {
          throw new Error('selector timeout');
        }),
        waitForLoadState: vi.fn(async () => undefined),
        $$eval: vi.fn(async () => []),
        $: vi.fn(async () => null),
      })) as never;

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(out).toEqual([]);
    });

    it('returns [] gracefully on AntiBotBlockError', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => ({})),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => {
          throw new StubAntiBotBlockError('blocked', { status: 403, title: 'Access denied' });
        }),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toEqual([]);
      expect(runtime.closeAll).toHaveBeenCalled();
    });

    it('returns [] gracefully on NavigationTimeout', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => ({})),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => {
          throw new StubNavigationTimeout('timeout', { url: 'https://careers.givaudan.com/' });
        }),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toEqual([]);
    });

    it('returns [] gracefully on BrowserLaunchError', async () => {
      const runtime = {
        createBrowser: vi.fn(async () => {
          throw new StubBrowserLaunchError('chromium not installed');
        }),
        createPoliteContext: vi.fn(async () => ({})),
        fetchWithRateLimit: vi.fn(async () => ({})),
        closeAll: vi.fn(async () => undefined),
        AntiBotBlockError: StubAntiBotBlockError,
        NavigationTimeout: StubNavigationTimeout,
        BrowserLaunchError: StubBrowserLaunchError,
      };

      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toEqual([]);
    });
  });

  // ── End-to-end through fetchAllGivaudanJobs ──
  describe('fetchAllGivaudanJobs (with stubbed runtime)', () => {
    it('builds NormalizedJob shape from a Phenom card', async () => {
      const cards: CardShape[] = [
        {
          title: 'Senior Process Engineer',
          location: 'Vernier, Switzerland',
          url: '/global/en/job/999/senior-process-engineer',
          postedDate: '2026-05-04',
        },
      ];
      const { runtime } = makeRuntime({ pages: [cards] });

      const jobs = await fetchAllGivaudanJobs({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.id).toMatch(/^givaudan-/);
      expect(job.company).toBe(GIVAUDAN_COMPANY_NAME);
      expect(job.companyKey).toBe(GIVAUDAN_KEY);
      expect(job.title).toBe('Senior Process Engineer');
      expect(job.location).toBe('Vernier, Switzerland');
      expect(job.canton).toBe('GE'); // Vernier is in canton GE
      expect(job.country).toBe('CH');
      expect(job.url).toBe(
        'https://careers.givaudan.com/global/en/job/999/senior-process-engineer',
      );
      expect(job.applyUrl).toBe(job.url);
      expect(job.postedDate).toBe('2026-05-04');
      expect(job.slug).toMatch(/^senior-process-engineer/);
      expect(job.slugByLocale).toHaveProperty(job.sourceLang);
    });

    it('returns [] when no Swiss listings are found', async () => {
      const cards: CardShape[] = [
        { title: 'Foreign role', location: 'Paris, France', url: '/job/1', postedDate: '' },
      ];
      const { runtime } = makeRuntime({ pages: [cards] });

      const jobs = await fetchAllGivaudanJobs({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(jobs).toEqual([]);
    });
  });

  // ── Internal helpers ──
  describe('SWISS_LOCATION_RX', () => {
    it.each([
      ['Vernier, Switzerland', true],
      ['Genève, Switzerland', true],
      ['Geneva (CH)', true],
      ['Kemptthal, Switzerland', true],
      ['Paris, France', false],
      ['New York, USA', false],
      ['', false],
    ])('matches %s → %s', (input, expected) => {
      expect(__testables.SWISS_LOCATION_RX.test(input)).toBe(expected);
    });
  });

  describe('resolveApplyUrl', () => {
    it('resolves relative URL against careers domain', () => {
      expect(__testables.resolveApplyUrl('/global/en/job/1')).toBe(
        'https://careers.givaudan.com/global/en/job/1',
      );
    });

    it('passes through absolute URL untouched', () => {
      expect(__testables.resolveApplyUrl('https://careers.givaudan.com/global/en/job/2')).toBe(
        'https://careers.givaudan.com/global/en/job/2',
      );
    });

    it('falls back to SEARCH_URL on empty input', () => {
      expect(__testables.resolveApplyUrl('')).toBe(__testables.SEARCH_URL);
    });
  });
});
