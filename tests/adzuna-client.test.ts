import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  searchAdzuna,
  searchAdzunaAllPages,
  parseAdzunaJobs,
  ADZUNA_DEFAULT_RESULTS_PER_PAGE,
  ADZUNA_DEFAULT_MAX_PAGES,
  ADZUNA_FREE_TIER_MONTHLY_CAP,
} from '../scripts/lib/adzuna-client.mjs';

interface MockJob {
  id?: string;
  title?: string;
  description?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  redirect_url?: string;
  created?: string;
}

function buildResponse(overrides: { count?: number; results?: MockJob[] } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      count: overrides.count ?? overrides.results?.length ?? 0,
      results: overrides.results ?? [],
    }),
  } as unknown as Response;
}

describe('adzuna-client', () => {
  let tmpCacheDir: string;

  beforeEach(async () => {
    tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adzuna-cache-'));
  });

  afterEach(async () => {
    await fs.rm(tmpCacheDir, { recursive: true, force: true });
  });

  describe('exports', () => {
    it('exposes free-tier constants', () => {
      expect(ADZUNA_DEFAULT_RESULTS_PER_PAGE).toBe(50);
      expect(ADZUNA_DEFAULT_MAX_PAGES).toBeGreaterThanOrEqual(1);
      expect(ADZUNA_FREE_TIER_MONTHLY_CAP).toBe(1000);
    });
  });

  describe('searchAdzuna', () => {
    it('throws when company is missing', async () => {
      await expect(
        // @ts-expect-error — intentional bad input
        searchAdzuna({ appId: 'x', appKey: 'y', cacheDir: tmpCacheDir }),
      ).rejects.toThrow(/company/);
    });

    it('throws when credentials are missing and no cache hit', async () => {
      await expect(
        searchAdzuna({
          company: 'Richemont',
          cacheDir: tmpCacheDir,
          appId: '',
          appKey: '',
          _fetchImpl: () => {
            throw new Error('should not be called');
          },
        }),
      ).rejects.toThrow(/ADZUNA_APP_ID/);
    });

    it('calls Adzuna API with correct URL + params', async () => {
      let calledUrl = '';
      const fetchImpl = async (url: string) => {
        calledUrl = url;
        return buildResponse({ results: [] });
      };
      await searchAdzuna({
        company: 'Richemont',
        country: 'ch',
        page: 2,
        resultsPerPage: 25,
        appId: 'APPID123',
        appKey: 'KEY456',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
      });
      expect(calledUrl).toContain('https://api.adzuna.com/v1/api/jobs/ch/search/2');
      expect(calledUrl).toContain('app_id=APPID123');
      expect(calledUrl).toContain('app_key=KEY456');
      expect(calledUrl).toContain('results_per_page=25');
      expect(calledUrl).toContain('what_phrase=Richemont');
    });

    it('caches the response and avoids a second network call same day', async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return buildResponse({ results: [{ id: '1', title: 'Test', redirect_url: 'https://adzuna.ch/jobs/1' }] });
      };
      const args = {
        company: 'Richemont',
        appId: 'A',
        appKey: 'B',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
        _cacheDate: '2026-05-10',
      };
      const first = await searchAdzuna(args);
      const second = await searchAdzuna(args);
      expect(calls).toBe(1);
      expect(first._fromCache).toBe(false);
      expect(second._fromCache).toBe(true);
      expect(second.results).toHaveLength(1);
    });

    it('throws on non-OK HTTP response', async () => {
      const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
      await expect(
        searchAdzuna({
          company: 'Richemont',
          appId: 'A',
          appKey: 'B',
          cacheDir: tmpCacheDir,
          _fetchImpl: fetchImpl,
        }),
      ).rejects.toThrow(/HTTP 503/);
    });
  });

  describe('searchAdzunaAllPages', () => {
    it('stops paginating when results.length < resultsPerPage', async () => {
      const pages = [
        Array.from({ length: 50 }, (_, i) => ({
          id: `${i}`,
          title: `Job ${i}`,
          redirect_url: `https://adzuna.ch/jobs/${i}`,
          company: { display_name: 'Richemont' },
        })),
        // page 2: short → stop
        Array.from({ length: 3 }, (_, i) => ({
          id: `p2-${i}`,
          title: `Job p2-${i}`,
          redirect_url: `https://adzuna.ch/jobs/p2-${i}`,
          company: { display_name: 'Richemont' },
        })),
      ];
      let pageCalls = 0;
      const fetchImpl = async () => {
        const page = pages[pageCalls] ?? [];
        pageCalls += 1;
        return buildResponse({ results: page });
      };
      const { results, liveCalls } = await searchAdzunaAllPages({
        company: 'Richemont',
        appId: 'A',
        appKey: 'B',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
        _cacheDate: '2026-05-10',
        maxPages: 5,
      });
      expect(results).toHaveLength(53);
      expect(liveCalls).toBe(2);
      expect(pageCalls).toBe(2);
    });

    it('respects maxPages cap to honour free tier', async () => {
      const fullPage = Array.from({ length: 50 }, (_, i) => ({
        id: `${i}`,
        title: `Job ${i}`,
        redirect_url: `https://adzuna.ch/jobs/${i}`,
        company: { display_name: 'MSC Cargo' },
      }));
      let pageCalls = 0;
      const fetchImpl = async () => {
        pageCalls += 1;
        return buildResponse({ results: fullPage });
      };
      const { liveCalls } = await searchAdzunaAllPages({
        company: 'MSC',
        appId: 'A',
        appKey: 'B',
        cacheDir: tmpCacheDir,
        _fetchImpl: fetchImpl,
        _cacheDate: '2026-05-10',
        maxPages: 2,
      });
      expect(liveCalls).toBe(2);
      expect(pageCalls).toBe(2);
    });
  });

  describe('parseAdzunaJobs', () => {
    const employer = {
      key: 'richemont',
      name: 'Richemont',
      domain: 'richemont.com',
      match: (display: string) => /richemont|cartier/i.test(display),
      sector: 'Lusso',
      defaultLocation: 'Bellevue',
      defaultCanton: 'GE',
      parserSourceLabel: 'Richemont Adzuna Fallback',
    };

    it('throws when employer is missing required keys', () => {
      expect(() =>
        // @ts-expect-error — intentional bad input
        parseAdzunaJobs({ results: [] }, { key: 'richemont' }),
      ).toThrow();
    });

    it('returns empty array for empty results', () => {
      expect(parseAdzunaJobs({ results: [] }, employer)).toEqual([]);
      // @ts-expect-error — intentional missing key
      expect(parseAdzunaJobs({}, employer)).toEqual([]);
    });

    it('filters out listings whose company.display_name does not match', () => {
      const raw = {
        results: [
          {
            id: '1',
            title: 'Watchmaker',
            company: { display_name: 'Richemont International' },
            location: { display_name: 'Geneva' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/1',
            created: '2026-05-01T10:00:00Z',
            description: 'Watchmaker role at the maison.',
          },
          {
            id: '2',
            title: 'Pilot',
            company: { display_name: 'SWISS Air Lines' },
            location: { display_name: 'Zurich' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/2',
            created: '2026-05-02T10:00:00Z',
            description: 'Pilot role.',
          },
          {
            id: '3',
            title: 'Sales Associate',
            company: { display_name: 'Cartier Joaillerie' },
            location: { display_name: 'Geneva' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/3',
            created: '2026-05-03T10:00:00Z',
            description: 'Sales role at Cartier boutique.',
          },
        ],
      };
      const jobs = parseAdzunaJobs(raw, employer);
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j: { title: string }) => j.title)).toEqual([
        'Watchmaker',
        'Sales Associate',
      ]);
    });

    it('emits ParsedJob shape with required fields', () => {
      const raw = {
        results: [
          {
            id: '1',
            title: 'Senior Watchmaker',
            company: { display_name: 'Richemont International' },
            location: { display_name: 'Geneva, Switzerland' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/1',
            created: '2026-05-01T10:00:00Z',
            description: 'Lead watchmaker.',
          },
        ],
      };
      const [job] = parseAdzunaJobs(raw, employer);
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey', 'companyDomain',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
        'applyUrl', 'postedDate', 'sector', 'currency',
      ];
      for (const f of required) expect(job).toHaveProperty(f);
      expect(job.id).toMatch(/^richemont-/);
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(job.applyUrl).toBe('https://www.adzuna.ch/jobs/details/1');
      expect(job.url).toBe('https://www.adzuna.ch/jobs/details/1');
      expect(job.postedDate).toBe('2026-05-01');
      expect(job.sector).toBe('Lusso');
      expect(job.source).toBe('Richemont Adzuna Fallback');
      expect(job.companyDomain).toBe('richemont.com');
    });

    it('skips listings with missing redirect_url or invalid URL', () => {
      const raw = {
        results: [
          {
            id: '1',
            title: 'Watchmaker',
            company: { display_name: 'Richemont' },
            redirect_url: '',
          },
          {
            id: '2',
            title: 'Designer',
            company: { display_name: 'Cartier' },
            redirect_url: 'not-a-url',
          },
          {
            id: '3',
            title: 'Engineer',
            company: { display_name: 'Richemont' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/3',
          },
        ],
      };
      const jobs = parseAdzunaJobs(raw, employer);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Engineer');
    });

    it('deduplicates by stable id derived from URL hash', () => {
      const raw = {
        results: [
          {
            id: '1',
            title: 'Watchmaker',
            company: { display_name: 'Richemont' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/duplicate',
          },
          {
            id: '2',
            title: 'Watchmaker',
            company: { display_name: 'Richemont' },
            redirect_url: 'https://www.adzuna.ch/jobs/details/duplicate',
          },
        ],
      };
      const jobs = parseAdzunaJobs(raw, employer);
      expect(jobs).toHaveLength(1);
    });
  });
});
