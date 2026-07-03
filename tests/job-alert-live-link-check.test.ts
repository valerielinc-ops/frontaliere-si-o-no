/**
 * Guard for issue #3172: scripts/send-job-alerts.mjs must not embed a dead
 * job-page link in an alert email. data/jobs.json is a periodic crawl
 * snapshot — a job listed as "recent" at crawl-time can be pulled/expired,
 * or its per-locale SSG page may not have deployed yet, before the alert
 * actually sends. filterLiveJobs() HEAD-checks each job's live page (the
 * same URL buildAlertEmail() would embed) and drops the ones that don't
 * resolve, reusing the exact liveness semantics of
 * check-journalist-article-links.mjs (issue #3174) via
 * scripts/lib/live-link-check.mjs.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { filterLiveJobs, jobPageUrl } from '../scripts/send-job-alerts.mjs';

function fixtureJob(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'senior-software-engineer-acme-corp-lugano',
    slugByLocale: {},
    ...overrides,
  };
}

describe('jobPageUrl', () => {
  it('builds the IT (canonical, no prefix) job-board URL from the slug', () => {
    const url = jobPageUrl(fixtureJob(), 'it');
    expect(url).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/senior-software-engineer-acme-corp-lugano');
  });

  it('builds a locale-prefixed URL for non-IT locales', () => {
    const url = jobPageUrl(fixtureJob(), 'en');
    expect(url).toBe('https://frontaliereticino.ch/en/find-jobs-ticino/senior-software-engineer-acme-corp-lugano');
  });

  it('prefers the locale-specific slug over the default slug', () => {
    const job = fixtureJob({ slugByLocale: { en: 'senior-software-engineer-en' } });
    expect(jobPageUrl(job, 'en')).toContain('senior-software-engineer-en');
  });

  it('returns null when the job has no slug at all', () => {
    expect(jobPageUrl(fixtureJob({ slug: '', slugByLocale: {} }), 'it')).toBeNull();
  });
});

describe('filterLiveJobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a job whose page resolves live, drops one that 404s', async () => {
    const liveJob = fixtureJob({ slug: 'live-job' });
    const deadJob = fixtureJob({ slug: 'dead-job' });
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('dead-job')) return { status: 404, ok: false };
      return { status: 200, ok: true };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new Map();
    const out = await filterLiveJobs([liveJob, deadJob], 'it', cache);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(liveJob);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/live-job',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('never re-checks the same URL twice in one run (shared cache)', async () => {
    const jobA = fixtureJob({ slug: 'shared-slug' });
    const jobB = fixtureJob({ slug: 'shared-slug' });
    const fetchSpy = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new Map();
    const out = await filterLiveJobs([jobA, jobB], 'it', cache);

    expect(out).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never drops a job with no resolvable slug (falls back to the site root, always live)', async () => {
    const noSlugJob = fixtureJob({ slug: '', slugByLocale: {} });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await filterLiveJobs([noSlugJob], 'it', new Map());

    expect(out).toEqual([noSlugJob]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails open (returns jobs unfiltered) when almost every check fails — treats it as a network blip, not real 404s', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => fixtureJob({ slug: `job-${i}` }));
    // Simulate an outbound network outage on OUR side: every fetch throws.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchSpy);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await filterLiveJobs(jobs, 'it', new Map());

    expect(out).toEqual(jobs);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('suspected transient network issue'));
    warnSpy.mockRestore();
  });

  it('does filter a genuinely mixed batch above the fail-open sample size (real 404s, not a blip)', async () => {
    // 10 jobs, 6 dead — below fail-open MIN_SAMPLE=4 is moot here (10 ≥ 4), but
    // the live ratio (4/10 = 0.4) is ABOVE the 0.34 fail-open threshold, so
    // this must filter normally rather than fail open.
    const jobs = Array.from({ length: 10 }, (_, i) => fixtureJob({ slug: `job-${i}` }));
    const fetchSpy = vi.fn(async (url: string) => {
      const idx = Number(String(url).match(/job-(\d+)/)?.[1]);
      return idx < 4 ? { status: 200, ok: true } : { status: 404, ok: false };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const out = await filterLiveJobs(jobs, 'it', new Map());

    expect(out).toHaveLength(4);
  });

  it('falls back to a ranged GET when the origin rejects HEAD with 405 (mirrors check-journalist-article-links.mjs)', async () => {
    const job = fixtureJob({ slug: 'head-rejected' });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return { status: 405, ok: false };
      return { status: 206, ok: false };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const out = await filterLiveJobs([job], 'it', new Map());

    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
