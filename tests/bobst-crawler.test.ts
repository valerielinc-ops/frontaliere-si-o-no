import { describe, it, expect, vi } from 'vitest';
import {
  BOBST_KEY,
  BOBST_COMPANY_NAME,
  isBobstJob,
  isTrustedDomain,
  fetchAllBobstJobs,
  __testables,
} from '../scripts/lib/bobst-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

/* ── Stubbed Playwright runtime ────────────────────────────── */

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

type RowShape = {
  title: string;
  href: string;
  cellText: string;
};

interface StubRuntimeOptions {
  pages: RowShape[][];
  rowsAppear?: boolean;
}

function makeRuntime(opts: StubRuntimeOptions) {
  const pageBatches = opts.pages;
  let pageIdx = -1; // bumped to 0 on first fetchWithRateLimit

  const makePage = (idx: number) => ({
    waitForSelector: vi.fn(async () => {
      if (opts.rowsAppear === false) {
        throw new Error('selector timeout');
      }
      if (idx >= pageBatches.length || pageBatches[idx].length === 0) {
        throw new Error('selector timeout');
      }
      return null;
    }),
    $$eval: vi.fn(async () => pageBatches[idx] || []),
    close: vi.fn(async () => undefined),
  });

  return {
    runtime: {
      createBrowser: vi.fn(async () => ({})),
      createPoliteContext: vi.fn(async () => ({})),
      fetchWithRateLimit: vi.fn(async () => {
        pageIdx += 1;
        return makePage(pageIdx);
      }),
      closeAll: vi.fn(async () => undefined),
      AntiBotBlockError: StubAntiBotBlockError,
      NavigationTimeout: StubNavigationTimeout,
      BrowserLaunchError: StubBrowserLaunchError,
    },
  };
}

describe('Bobst crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BOBST_KEY).toBe('bobst');
    expect(BOBST_COMPANY_NAME).toBe('Bobst');
  });

  // ── isCompanyJob ──
  describe('isBobstJob', () => {
    it('matches by companyKey', () => {
      expect(isBobstJob({ companyKey: 'bobst' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBobstJob({ company: 'Bobst' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBobstJob({ url: 'https://bobst.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBobstJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBobstJob(null)).toBe(false);
      expect(isBobstJob(undefined)).toBe(false);
      expect(isBobstJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bobst.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.bobst.com/job/456')).toBe(true);
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
      expect(slugify('Developer bobst ch')).toBe('developer-bobst-ch');
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
      id: 'bobst-abc123',
      slug: 'test-position-bobst-ch',
      slugByLocale: { en: 'test-position-bobst-ch' },
      company: 'Bobst',
      companyKey: 'bobst',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://bobst.com/jobs/test',
      source: 'Bobst Dedicated Parser',
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
      expect(validJob.id).toMatch(/^bobst-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Umantis URL helpers ──
  describe('buildPageUrl / resolveApplyUrl', () => {
    it('builds a Umantis pagination URL preserving DesignID + lang', () => {
      const u1 = __testables.buildPageUrl(1);
      const u2 = __testables.buildPageUrl(2);
      expect(u1).toContain('jobs.bobst.com/Jobs/All');
      expect(u1).toContain('DesignID=10008');
      expect(u1).toContain('lang=eng');
      expect(u1).toContain('tc1152481=p1');
      expect(u2).toContain('tc1152481=p2');
    });

    it('resolves a relative Umantis Description href to the jobs.bobst.com host', () => {
      expect(__testables.resolveApplyUrl('/Vacancies/7638/Description/3')).toBe(
        'https://jobs.bobst.com/Vacancies/7638/Description/3',
      );
    });

    it('passes through an absolute URL untouched', () => {
      expect(__testables.resolveApplyUrl('https://jobs.bobst.com/Vacancies/9999/Description/2')).toBe(
        'https://jobs.bobst.com/Vacancies/9999/Description/2',
      );
    });

    it('falls back to the listing URL on empty input', () => {
      expect(__testables.resolveApplyUrl('')).toBe(__testables.UMANTIS_LISTING_URL);
    });
  });

  // ── Umantis row metadata parsing ──
  describe('parseRowMetadata', () => {
    it('extracts location, employmentType, contractTerm, department, postedDate', () => {
      const cellText =
        'Apprentissages | Online since: 08.05.2026 ' +
        '2025_Stagiaire MPC (3+1) - Ressources Humaines - Centre de Formation' +
        ' | Type: Full time | Term of employment: Limited duration ' +
        '| Starting as: Apprentice | Department: Human Resources (HR) ' +
        '| Switzerland (Mex)';
      const meta = __testables.parseRowMetadata(
        cellText,
        '2025_Stagiaire MPC (3+1) - Ressources Humaines - Centre de Formation',
      );
      expect(meta.employmentType).toBe('Full time');
      expect(meta.contractTerm).toBe('Limited duration');
      expect(meta.department).toBe('Human Resources (HR)');
      expect(meta.location).toBe('Switzerland (Mex)');
      expect(meta.postedDate).toBe('08.05.2026');
    });

    it('returns blank fields when row is empty', () => {
      const meta = __testables.parseRowMetadata('', 'Whatever');
      expect(meta.location).toBe('');
      expect(meta.employmentType).toBe('');
    });
  });

  // ── Umantis scraper (Playwright path) ──
  describe('fetchJobListings (Umantis Playwright)', () => {
    const titleA = 'Senior Mechanical Engineer';
    const titleB = 'Field Service Technician';
    const titleC = 'Apprentice Mechatronics';

    const rowA: RowShape = {
      title: titleA,
      href: '/Vacancies/8895/Description/2',
      cellText:
        `Engineering | Online since: 05.05.2026 ${titleA} | Type: Full time | Term of employment: Permanent | Starting as: Mid | Department: Engineering | Switzerland (Mex)`,
    };
    const rowB: RowShape = {
      title: titleB,
      href: '/Vacancies/8957/Description/2',
      cellText:
        `Field Service | Online since: 04.05.2026 ${titleB} | Type: Full time | Department: Field Service | Switzerland (Mex)`,
    };
    const rowC: RowShape = {
      title: titleC,
      href: '/Vacancies/7638/Description/3',
      cellText:
        `Apprentissages | Online since: 08.05.2026 ${titleC} | Type: Full time | Term of employment: Limited duration | Starting as: Apprentice | Department: Human Resources (HR) | Switzerland (Mex)`,
    };

    it('returns rows from page 1 and resolves apply URLs to absolute', async () => {
      const { runtime } = makeRuntime({ pages: [[rowA, rowB], []] });
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toHaveLength(2);
      expect(out[0].title).toBe(titleA);
      expect(out[0].url).toBe('https://jobs.bobst.com/Vacancies/8895/Description/2');
      expect(out[0].location).toBe('Switzerland (Mex)');
      expect(out[0].employmentType).toBe('Full time');
      expect(out[0].department).toBe('Engineering');
      expect(out[1].url).toBe('https://jobs.bobst.com/Vacancies/8957/Description/2');
    });

    it('paginates until natural end of pagination (empty page)', async () => {
      const { runtime } = makeRuntime({ pages: [[rowA], [rowB, rowC], []] });
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toHaveLength(3);
      expect(out.map((r: { title: string }) => r.title)).toEqual([titleA, titleB, titleC]);
    });

    it('detects Umantis wrap-around when page N repeats page 1 first id', async () => {
      const { runtime } = makeRuntime({
        pages: [[rowA, rowB], [rowC], [rowA, rowB]], // page 3 wraps back to page 1
      });
      const out = await __testables.fetchJobListings({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(out).toHaveLength(3);
      expect(out.map((r: { title: string }) => r.title).sort()).toEqual(
        [titleA, titleB, titleC].sort(),
      );
    });

    it('returns [] when the row selector never appears on page 1 (selector drift)', async () => {
      const { runtime } = makeRuntime({ pages: [[]], rowsAppear: false });
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
          throw new StubNavigationTimeout('timeout', { url: 'https://jobs.bobst.com/' });
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

  // ── End-to-end through fetchAllBobstJobs ──
  describe('fetchAllBobstJobs (with stubbed runtime)', () => {
    it('builds NormalizedJob shape from a Umantis row', async () => {
      const row: RowShape = {
        title: 'Senior Mechanical Engineer',
        href: '/Vacancies/8895/Description/2',
        cellText:
          'Engineering | Online since: 05.05.2026 Senior Mechanical Engineer | Type: Full time | Term of employment: Permanent | Starting as: Mid | Department: Engineering | Switzerland (Mex)',
      };
      const { runtime } = makeRuntime({ pages: [[row], []] });

      const jobs = await fetchAllBobstJobs({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });

      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.id).toMatch(/^bobst-/);
      expect(job.company).toBe(BOBST_COMPANY_NAME);
      expect(job.companyKey).toBe(BOBST_KEY);
      expect(job.title).toBe('Senior Mechanical Engineer');
      expect(job.location).toBe('Switzerland (Mex)');
      expect(job.country).toBe('CH');
      expect(job.url).toBe('https://jobs.bobst.com/Vacancies/8895/Description/2');
      expect(job.applyUrl).toBe(job.url);
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.experienceLevel).toBe('senior');
      expect(job.category).toBe('Ingegneria');
      expect(job.postedDate).toBe('05.05.2026');
      expect(job.slug).toMatch(/^senior-mechanical-engineer/);
      expect(job.slugByLocale).toHaveProperty(job.sourceLang);
    });

    it('returns [] when the listing is empty', async () => {
      const { runtime } = makeRuntime({ pages: [[]], rowsAppear: false });
      const jobs = await fetchAllBobstJobs({
        _runtime: async () => runtime,
        _sleepMs: 0,
      });
      expect(jobs).toEqual([]);
    });
  });
});
