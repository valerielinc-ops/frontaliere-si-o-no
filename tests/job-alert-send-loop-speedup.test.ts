/**
 * The three speed-ups of scripts/send-job-alerts.mjs must not change a single
 * recipient, match or write (run 35422626497: ~9 min matching, 157 s of
 * impression commits):
 *
 *   1. createJobFeatureCache — memoised job-side scoring features. Oracle: the
 *      uncached scorer, over a grid of jobs x alert profiles x locales, with
 *      ONE cache shared across every alert (the production shape), so a
 *      cross-locale or cross-alert leak would show up as a different score.
 *   2. createJobLivenessPrefetcher — live-link checks moved off the per-alert
 *      critical path. Oracle: filterLiveJobs without prefetch. After a drain,
 *      filterLiveJobs must answer identically with zero further fetches, and
 *      the pool must never exceed its concurrency cap.
 *   3. recordJobEmailImpressions — batches committed by a bounded pool. Oracle:
 *      the exact set of (document, data) writes, each document written once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAlertProfile,
  createJobFeatureCache,
  scoreJobForAlert,
} from '../services/jobAlertMatching.mjs';
import {
  createJobLivenessPrefetcher,
  filterLiveJobs,
  jobPageUrl,
  planAlertMatch,
} from '../scripts/send-job-alerts.mjs';
import {
  IMPRESSION_BATCH_SIZE,
  IMPRESSION_COMMIT_CONCURRENCY,
  recordJobEmailImpressions,
} from '../functions/src/lib/jobEmailRankingStore.js';

const TITLES = [
  'Infermiere diplomato 80-100%',
  'Senior Software Engineer (Java)',
  'Contabile / Accountant',
  'Magazziniere carrellista',
  'Elektriker EFZ',
  'Ingénieur logiciel',
  'Sales Manager Ticino',
  'Assistente di cura',
];
const CITIES = [
  ['Lugano', 'TI'],
  ['Bellinzona', 'TI'],
  ['Mendrisio', 'TI'],
  ['Zürich', 'ZH'],
  ['Basel', 'BS'],
  ['Genève', 'GE'],
];
const COMPANIES = ['EOC', 'Coop Ticino', 'Banca Stato', 'ABB Svizzera', 'Migros', 'Swiss Medical Network'];
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-19T05:00:00Z');

function fixtureJobs() {
  const jobs = [];
  for (let i = 0; i < 96; i++) {
    const [location, canton] = CITIES[i % CITIES.length];
    const title = TITLES[i % TITLES.length];
    jobs.push({
      id: `job-${i}`,
      slug: `job-${i}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      slugByLocale: i % 3 === 0 ? { en: `job-${i}-en` } : {},
      title,
      titleByLocale: i % 2 === 0 ? { de: `${title} (DE)`, en: `${title} EN` } : {},
      description: `Descrizione ${i}: cerchiamo ${title}. Ambiente dinamico, sede ${location}. ${'lorem ipsum '.repeat(i % 7)}`,
      company: COMPANIES[i % COMPANIES.length],
      category: i % 4 === 0 ? 'sanità' : 'informatica',
      sector: i % 5 === 0 ? 'healthcare' : 'it',
      location,
      canton,
      contract: i % 2 ? 'full-time' : 'part-time',
      firstSeenAt: new Date(NOW - (i % 4) * DAY).toISOString(),
    });
  }
  return jobs;
}

function fixtureAlerts() {
  return [
    { id: 'kw', email: 'a@example.test', locale: 'it', keywords: ['infermiere'] },
    { id: 'kw-geo', email: 'b@example.test', locale: 'de', keywords: ['engineer', 'elektriker'], locations: ['zürich'] },
    { id: 'canton', email: 'c@example.test', locale: 'fr', cantonFilter: ['TI'] },
    { id: 'one-tap', email: 'd@example.test', locale: 'en', sourceJobTitle: 'Sales Manager', sourceJobSlug: 'sales-manager-ticino' },
    { id: 'pinned-job', email: 'e@example.test', locale: 'it', specificJobId: 'job-7' },
    { id: 'pinned-company', email: 'f@example.test', locale: 'it', specificCompanyKey: 'eoc' },
    {
      id: 'dedup',
      email: 'g@example.test',
      locale: 'it',
      sectors: ['sanità'],
      sentJobIds: { 'job-0': new Date(NOW - DAY).toISOString() },
    },
    { id: 'no-locale', email: 'h@example.test', keywords: ['contabile'], contractTypes: ['full-time'] },
    // Hits only the German localized title: a cache that leaked one locale's
    // features into another would score it differently.
    { id: 'localized-title', email: 'i@example.test', locale: 'de', keywords: ['(de)'] },
  ];
}

const SUBSCRIBERS: Record<string, any> = {
  'c@example.test': { location_interest: 'lugano', job_category: 'sanità' },
  'd@example.test': { job_company: 'Coop Ticino', geo_city: 'bellinzona' },
  'g@example.test': { sector_interest: 'healthcare' },
};

function planContext(featureCache: unknown) {
  return {
    behaviorProfiles: new Map(),
    lastClickedUrlByEmail: new Map(),
    locationIndex: new Map(),
    cityToCanton: new Map([['lugano', 'ti'], ['bellinzona', 'ti']]),
    subscriberProfiles: new Map(Object.entries(SUBSCRIBERS)),
    recentJobs: fixtureJobs(),
    now: NOW,
    featureCache,
  };
}

describe('createJobFeatureCache', () => {
  it('scores every job x profile x locale exactly like the uncached scorer, with one cache shared by all alerts', () => {
    const jobs = fixtureJobs();
    const cache = createJobFeatureCache();
    let compared = 0;
    let positive = 0;
    for (const alert of fixtureAlerts()) {
      const profile = buildAlertProfile(alert, SUBSCRIBERS[alert.email] || null, {});
      for (const locale of ['it', 'de', 'fr', 'en', undefined]) {
        for (const job of jobs) {
          const expected = scoreJobForAlert(job, profile, locale);
          expect(scoreJobForAlert(job, profile, locale, cache)).toBe(expected);
          compared++;
          if (expected > 0) positive++;
        }
      }
    }
    // The grid must exercise both outcomes, or the equality proves nothing.
    expect(compared).toBe(9 * 5 * 96);
    expect(positive).toBeGreaterThan(100);
    expect(compared - positive).toBeGreaterThan(100);
  });

  it('keys by locale: the same job gives a different localized title per locale', () => {
    const job = fixtureJobs()[0];
    const cache = createJobFeatureCache();
    expect(cache.get(job, 'de').titleText).toContain('(de)');
    expect(cache.get(job, 'en').titleText).not.toContain('(de)');
    expect(cache.get(job, 'de')).toBe(cache.get(job, 'de'));
  });
});

describe('planAlertMatch', () => {
  it('produces the same ranked, deduped match list with and without the feature cache', () => {
    const cached = planContext(createJobFeatureCache());
    const uncached = planContext(null);
    // Same job objects on both sides, as in production.
    uncached.recentJobs = cached.recentJobs;
    let nonEmpty = 0;
    for (const alert of fixtureAlerts()) {
      const a = planAlertMatch(alert, cached);
      const b = planAlertMatch(alert, uncached);
      expect(a.rankedCount).toBe(b.rankedCount);
      expect(a.zeroCause).toBe(b.zeroCause);
      expect(a.matched.map((j: any) => [j.id, j.relevanceScore])).toEqual(
        b.matched.map((j: any) => [j.id, j.relevanceScore]),
      );
      if (a.matched.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(5);
    // The dedup guard still drops the already-sent job.
    const dedup = planAlertMatch(fixtureAlerts().find((a) => a.id === 'dedup'), cached);
    expect(dedup.matched.map((j: any) => j.id)).not.toContain('job-0');
  });
});

describe('createJobLivenessPrefetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    let inFlight = 0;
    let peak = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      const dead = /job-(\d+)/.exec(String(url));
      const n = dead ? Number(dead[1]) : 0;
      if (n % 5 === 0) return { status: 404, ok: false, text: async () => '' };
      if (n % 7 === 0) {
        return { status: 200, ok: true, text: async () => '<script>window.__EXPIRED_JOB_DATA__={}</script>' };
      }
      return { status: 200, ok: true, text: async () => '<html>live</html>' };
    });
    vi.stubGlobal('fetch', fetchSpy);
    return { fetchSpy, peak: () => peak };
  }

  it('fills the cache so filterLiveJobs answers identically with no further fetch', async () => {
    const jobs = fixtureJobs();
    const batches = [
      { jobs: jobs.slice(0, 40), locale: 'it' },
      { jobs: jobs.slice(20, 70), locale: 'it' },
      { jobs: jobs.slice(10, 50), locale: 'en' },
      { jobs: jobs.slice(60, 96), locale: 'de' },
    ];

    // Oracle: the pre-change path, one awaited filterLiveJobs per alert.
    const { fetchSpy: baselineFetch } = stubFetch();
    const baselineCache = new Map();
    const expected = [];
    for (const b of batches) expected.push(await filterLiveJobs(b.jobs, b.locale, baselineCache));
    const baselineFetches = baselineFetch.mock.calls.length;
    vi.unstubAllGlobals();

    const { fetchSpy, peak } = stubFetch();
    const cache = new Map();
    const prefetcher = createJobLivenessPrefetcher(cache, { concurrency: 3 });
    for (const b of batches) prefetcher.enqueue(b.jobs, b.locale);
    await prefetcher.drain();
    expect(fetchSpy.mock.calls.length).toBe(baselineFetches);
    expect(peak()).toBeLessThanOrEqual(3);
    expect(peak()).toBeGreaterThan(1);

    const actual = [];
    for (const b of batches) actual.push(await filterLiveJobs(b.jobs, b.locale, cache));
    expect(fetchSpy.mock.calls.length).toBe(baselineFetches);
    expect(actual.map((list) => list.map((j: any) => j.id))).toEqual(
      expected.map((list) => list.map((j: any) => j.id)),
    );
    expect(new Map(cache)).toEqual(new Map(baselineCache));
  });

  it('leaves a URL whose check threw uncached, so filterLiveJobs checks it itself', async () => {
    const jobs = fixtureJobs().slice(0, 3);
    const cache = new Map();
    const prefetcher = createJobLivenessPrefetcher(cache, {
      concurrency: 2,
      check: async (url: string) => {
        if (url.includes('job-1-')) throw new Error('boom');
        return true;
      },
    });
    prefetcher.enqueue(jobs, 'it');
    await prefetcher.drain();
    expect(cache.has(jobPageUrl(jobs[0], 'it'))).toBe(true);
    expect(cache.has(jobPageUrl(jobs[1], 'it'))).toBe(false);
    expect(cache.has(jobPageUrl(jobs[2], 'it'))).toBe(true);
  });

  it('drain resolves immediately when nothing was enqueued', async () => {
    await expect(createJobLivenessPrefetcher(new Map()).drain()).resolves.toBeUndefined();
  });
});

describe('recordJobEmailImpressions', () => {
  it('commits every write exactly once, through a bounded pool of batches', async () => {
    const writes: Array<{ path: string; data: any }> = [];
    let inFlight = 0;
    let peak = 0;
    let batchCount = 0;
    const ref = (path: string): any => ({ path });
    const db: any = {
      collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
      batch: () => {
        const pending: Array<{ path: string; data: any }> = [];
        batchCount++;
        return {
          set: (documentRef: any, data: any) => pending.push({ path: documentRef.path, data }),
          commit: async () => {
            expect(pending.length).toBeLessThanOrEqual(IMPRESSION_BATCH_SIZE);
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
            writes.push(...pending);
          },
        };
      },
    };
    const records = Array.from({ length: 150 }, (_, r) => ({
      deliveryId: `delivery-${r}`,
      surface: 'job_alert',
      surfaceId: `alert-${r}`,
      alertId: `alert-${r}`,
      email: `r${r}@example.test`,
      variant: 'control',
      sentAt: new Date(NOW),
      jobs: Array.from({ length: 10 }, (_, j) => ({ id: `job-${j}`, ranking: { position: j + 1 } })),
    }));

    const result = await recordJobEmailImpressions(db, records);

    // 150 deliveries + 1,500 stats rows + 1,500 events.
    expect(result).toEqual({ recorded: 150, writes: 3150 });
    expect(writes).toHaveLength(3150);
    expect(new Set(writes.map((w) => w.path)).size).toBe(3150);
    expect(batchCount).toBe(Math.ceil(3150 / IMPRESSION_BATCH_SIZE));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(IMPRESSION_COMMIT_CONCURRENCY);
  });

  it('still rejects when a batch fails, so the caller logs the failure', async () => {
    const db: any = {
      collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
      batch: () => ({ set: () => {}, commit: async () => { throw new Error('UNAVAILABLE'); } }),
    };
    await expect(recordJobEmailImpressions(db, [{
      deliveryId: 'd', surface: 'job_alert', surfaceId: 'a', email: 'x@example.test', jobs: [{ id: 'j' }],
    }])).rejects.toThrow('UNAVAILABLE');
  });
});
