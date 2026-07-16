/**
 * Guard for issue #3172 (and the expired-job report resolved alongside it):
 * scripts/send-job-alerts.mjs must not embed a dead OR expired job-page link
 * in an alert email. data/jobs.json is a periodic crawl snapshot — a job
 * listed as "recent" at crawl-time can be pulled/expired, or its per-locale
 * SSG page may not have deployed yet, before the alert actually sends.
 *
 * filterLiveJobs() GETs each job's live page (the same URL buildAlertEmail()
 * would embed) via checkJobPageLive() and drops jobs whose page doesn't
 * resolve OK OR renders the expired-job soft-landing bridge
 * (build-plugins/jobsSeoPagesPlugin.ts buildSoftLandingHtml, which seeds
 * `window.__EXPIRED_JOB_DATA__` — the site never serves a real 404 for a
 * once-known job slug, so HTTP status alone cannot tell a live job page from
 * an expired one).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { filterLiveJobs, jobPageUrl, checkJobPageLive } from '../scripts/send-job-alerts.mjs';

function liveResponse(status = 200, body = '<html>live job page</html>') {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

function expiredResponse() {
  return {
    status: 200,
    ok: true,
    text: async () => '<html><script>window.__EXPIRED_JOB_DATA__={"slug":"dead-job"};</script></html>',
  };
}

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
      if (String(url).includes('dead-job')) return liveResponse(404, '');
      return liveResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new Map();
    const out = await filterLiveJobs([liveJob, deadJob], 'it', cache);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(liveJob);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/live-job',
      expect.any(Object),
    );
    // GET, not HEAD — a HEAD response has no body to inspect for the expired marker.
    const [, init] = fetchSpy.mock.calls.find(([url]) => String(url).includes('live-job')) as [string, RequestInit];
    expect(init?.method).not.toBe('HEAD');
  });

  it('never re-checks the same URL twice in one run (shared cache)', async () => {
    const jobA = fixtureJob({ slug: 'shared-slug' });
    const jobB = fixtureJob({ slug: 'shared-slug' });
    const fetchSpy = vi.fn().mockResolvedValue(liveResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const cache = new Map();
    const out = await filterLiveJobs([jobA, jobB], 'it', cache);

    expect(out).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a job whose page is HTTP 200 but renders the expired-job soft-landing bridge', async () => {
    const liveJob = fixtureJob({ slug: 'live-job' });
    const expiredJob = fixtureJob({ slug: 'expired-job' });
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes('expired-job')) return expiredResponse();
      return liveResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);

    const out = await filterLiveJobs([liveJob, expiredJob], 'it', new Map());

    expect(out).toEqual([liveJob]);
  });

  it('checkJobPageLive: true for a plain 200 body, false when the body carries __EXPIRED_JOB_DATA__=', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(liveResponse()));
    expect(await checkJobPageLive('https://frontaliereticino.ch/cerca-lavoro-ticino/live-job')).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(expiredResponse()));
    expect(await checkJobPageLive('https://frontaliereticino.ch/cerca-lavoro-ticino/expired-job')).toBe(false);
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
      return idx < 4 ? liveResponse() : liveResponse(404, '');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const out = await filterLiveJobs(jobs, 'it', new Map());

    expect(out).toHaveLength(4);
  });
});

// checkLink option surface added for the deep-sample propagation gate (PR #4181
// review 🟡: the gate must REUSE checkLink, not re-implement it — these tests
// pin the option semantics both callers now share).
import { checkLink } from '../scripts/lib/live-link-check.mjs';

describe('checkLink — cacheBust + headers options (deep-sample gate reuse)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('default call has NO cache-bust query and no extra headers (send-job-alerts semantics unchanged)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await checkLink('https://example.com/page/');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/page/');
    expect(init.method).toBe('HEAD');
    expect(init.headers).toEqual({});
  });

  it('cacheBust appends a unique _=<ts> query param (origin read, edge defeated)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await checkLink('https://example.com/page/', 8000, { cacheBust: true });
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/example\.com\/page\/\?_=\d+$/);
  });

  it('cacheBust uses & when the URL already has a query string', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await checkLink('https://example.com/page/?x=1', 8000, { cacheBust: true });
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/example\.com\/page\/\?x=1&_=\d+$/);
  });

  it('custom headers reach both the HEAD and the 405-fallback ranged GET', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 206 }));
    const ok = await checkLink('https://example.com/p/', 8000, {
      headers: { 'User-Agent': 'gate/1.0', 'Cache-Control': 'no-cache' },
    });
    expect(ok).toBe(true);
    const [, headInit] = spy.mock.calls[0] as [string, RequestInit];
    const [, getInit] = spy.mock.calls[1] as [string, RequestInit];
    expect((headInit.headers as Record<string, string>)['User-Agent']).toBe('gate/1.0');
    expect((getInit.headers as Record<string, string>)['User-Agent']).toBe('gate/1.0');
    // Fallback GET keeps the ranged read on top of the custom headers.
    expect((getInit.headers as Record<string, string>).Range).toBe('bytes=0-0');
  });
});
