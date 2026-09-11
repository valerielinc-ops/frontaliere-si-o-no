import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collapseTechnicalDuplicates } from '../scripts/build-employer-insights.mjs';

vi.mock('@/services/posthog', () => ({ captureEvent: vi.fn() }));

const loadAnalyticsHelpers = async () => vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
const reloadAnalyticsHelpers = async () => {
  vi.resetModules();
  return vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
};
const jobBoardSource = readFileSync(
  resolve(__dirname, '../components/community/JobBoard.tsx'),
  'utf8',
);
const analyticsSource = readFileSync(resolve(__dirname, '../services/analytics.ts'), 'utf8');
const uiStateSource = readFileSync(resolve(__dirname, '../hooks/useUIState.ts'), 'utf8');

describe('GA4 page_view employer attribution', () => {
  it('keeps the canonical job identity after an alias and locale variant resolve', async () => {
    const { buildPageViewAttributionParams, resolveAnalyticsJobIdentity } = await loadAnalyticsHelpers();
    const identity = resolveAnalyticsJobIdentity({
      slug: 'canonical-role-it',
      slugByLocale: {
        it: 'canonical-role-it',
        en: 'canonical-role-en',
      },
      previousSlugs: ['old-role-it'],
      previousSlugsByLocale: { en: ['old-role-en'] },
      companyKey: 'canonical-employer',
    });

    expect(identity).toEqual({
      jobSlug: 'canonical-role-it',
      employerKey: 'canonical-employer',
    });
    expect(
      buildPageViewAttributionParams(
        '/en/find-jobs-ticino/old-role-en',
        identity,
      ),
    ).toEqual({
      job_slug: 'canonical-role-it',
      employer_key: 'canonical-employer',
    });
  });

  it('does not use a non-Italian slug as the canonical job identity', async () => {
    const { buildPageViewAttributionParams, resolveAnalyticsJobIdentity } = await loadAnalyticsHelpers();
    const identity = resolveAnalyticsJobIdentity({
      slug: 'flat-locale-slug',
      slugByLocale: { en: 'localized-role-en' },
      companyKey: 'canonical-employer',
    });

    expect(identity).toBeNull();
    expect(
      buildPageViewAttributionParams('/en/find-jobs-ticino/flat-locale-slug', identity),
    ).toEqual({});
  });

  it('keeps only the safe employer key when job_apply lacks the Italian slug', async () => {
    const { buildJobApplyAttributionParams } = await loadAnalyticsHelpers();

    expect(
      buildJobApplyAttributionParams({
        slug: 'flat-locale-slug',
        slugByLocale: { en: 'localized-role-en' },
        companyKey: 'canonical-employer',
      }),
    ).toEqual({ employer_key: 'canonical-employer', job_slug: '' });
  });

  it('attributes a localized company hub without inventing a job slug', async () => {
    const { buildPageViewAttributionParams, resolveAnalyticsCompanyHubKey } = await loadAnalyticsHelpers();
    expect(resolveAnalyticsCompanyHubKey(['canonical-employer', 'canonical-employer'])).toBe(
      'canonical-employer',
    );
    expect(
      buildPageViewAttributionParams(
        '/de/jobs-im-tessin/unternehmen-canonical-employer',
        { employerKey: 'canonical-employer' },
      ),
    ).toEqual({ employer_key: 'canonical-employer' });
  });

  it('refuses an ambiguous hub rather than attributing it to the wrong employer', async () => {
    const { resolveAnalyticsCompanyHubKey } = await loadAnalyticsHelpers();
    expect(resolveAnalyticsCompanyHubKey(['employer-a', 'employer-b'])).toBeNull();
  });

  it('refuses a hub when any matching record lacks the canonical employer key', async () => {
    const { resolveAnalyticsCompanyHubKey } = await loadAnalyticsHelpers();
    expect(resolveAnalyticsCompanyHubKey(['canonical-employer', undefined])).toBeNull();
  });

  it('routes page_view through the canonical attribution payload and owner callsites', () => {
    expect(analyticsSource).toMatch(
      /\.\.\.buildPageViewAttributionParams\(path, identity\)/,
    );
    expect(jobBoardSource).toMatch(
      /Analytics\.trackPageView\(path, undefined, pageViewIdentity\)/,
    );
    expect(jobBoardSource).toMatch(
      /companyRouteSlugCandidates\(job\.company, job\.companyKey\)/,
    );
    expect(jobBoardSource).toContain(
      "const pageViewPath = typeof window === 'undefined' ? '' : `${window.location.pathname}${window.location.search}${window.location.hash}`;",
    );
    expect(jobBoardSource).toContain('}, [pageViewIdentity, pageViewPath]);');
    expect(jobBoardSource).toContain("if (!pageViewPath) return;");
    expect(jobBoardSource).toContain("pageTemplate !== 'job_detail'");
    expect(jobBoardSource).not.toContain('if (!pageViewIdentity || !pageViewPath) return;');
    expect(uiStateSource).toMatch(
      /if \(!deferAttributionPageView\(initialPath\)\) Analytics\.trackPageView\(initialPath\)/,
    );
    expect(uiStateSource).toMatch(
      /if \(!deferAttributionPageView\(path\)\) Analytics\.trackPageView\(path\)/,
    );
  });

  it('reuses one emission id when the same page view is retried after async identity resolution', async () => {
    expect(analyticsSource).toContain(
      'getPageViewEmissionId(path, currentPageViewEmission, historyEntry)',
    );
    const { getPageViewEmissionId } = await loadAnalyticsHelpers();
    const path = '/offerte-di-lavoro-ticino/async-page-view/';
    const first = getPageViewEmissionId(path, null, 'entry-1');
    const retry = getPageViewEmissionId(path, { path, emissionId: first, historyEntry: 'entry-1' }, 'entry-1');
    const nextRoute = getPageViewEmissionId('/offerte-di-lavoro-ticino/next/', {
      path,
      emissionId: first,
      historyEntry: 'entry-1',
    }, 'entry-2');

    expect(retry).toBe(first);
    expect(nextRoute).not.toBe(first);
  });

  it('emits the same id for a same-route page-view retry after async identity resolution', async () => {
    const { captureEvent } = await import('@/services/posthog');
    const capture = vi.mocked(captureEvent);
    const path = '/offerte-di-lavoro-ticino/direct-page-view-retry/';
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_501);
    let historyState: Record<string, unknown> = { route: { activeTab: 'job-board' } };
    const historyRef = {
      length: 1,
      get state() { return historyState; },
      replaceState: vi.fn((nextState: Record<string, unknown>) => { historyState = nextState; }),
      pushState: vi.fn(),
    };
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', pathname: path },
      history: historyRef,
    });
    vi.stubGlobal('document', { title: 'Direct page-view retry' });
    capture.mockClear();

    try {
      const { Analytics } = await reloadAnalyticsHelpers();
      Analytics.trackPageView(path);
      Analytics.trackPageView(path, undefined, { employerKey: 'example-employer' });

      const pageViews = capture.mock.calls.filter(([eventName]) => eventName === '$pageview');
      expect(pageViews).toHaveLength(2);
      expect(pageViews[0][1]).toMatchObject({ emission_id: expect.any(String) });
      expect(pageViews[1][1].emission_id).toBe(pageViews[0][1].emission_id);
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('emits a new id when a same-route visit opens a new history entry', async () => {
    const { captureEvent } = await import('@/services/posthog');
    const capture = vi.mocked(captureEvent);
    const path = '/offerte-di-lavoro-ticino/same-route-new-visit/';
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_200);
    let historyState: Record<string, unknown> = { route: { entry: 'first' } };
    const pageWindow = {
      location: { origin: 'https://example.test', pathname: path },
      history: {
        length: 2,
        get state() { return historyState; },
        replaceState: vi.fn((nextState: Record<string, unknown>) => { historyState = nextState; }),
        pushState: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', pageWindow);
    vi.stubGlobal('document', { title: 'Same-route new visit' });
    capture.mockClear();

    try {
      const { Analytics } = await reloadAnalyticsHelpers();
      Analytics.trackPageView(path);
      expect(historyState).toMatchObject({ route: { entry: 'first' } });
      historyState = { route: { entry: 'second' } };
      Analytics.trackPageView(path);

      const pageViews = capture.mock.calls.filter(([eventName]) => eventName === '$pageview');
      expect(pageViews).toHaveLength(2);
      expect(pageViews[0][1]).toMatchObject({ emission_id: expect.any(String) });
      expect(pageViews[1][1].emission_id).not.toBe(pageViews[0][1].emission_id);
      const result = collapseTechnicalDuplicates(pageViews.map(([, params]) => ({
        event: '$pageview',
        observed: 1,
        emissionId: params.emission_id || '',
      })));
      expect(result).toMatchObject({ observed: 2, removed: 0, dedupUnavailable: 0 });
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not guess an entry id when history state cannot be extended', async () => {
    const { Analytics } = await loadAnalyticsHelpers();
    const { captureEvent } = await import('@/services/posthog');
    const capture = vi.mocked(captureEvent);
    const path = '/offerte-di-lavoro-ticino/unidentifiable-history-entry/';
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(3_000).mockReturnValueOnce(3_501);
    const historyRef = {
      length: 2,
      state: 'state-owned-by-another-navigation',
      replaceState: vi.fn(),
      pushState: vi.fn(),
    };
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', pathname: path },
      history: historyRef,
    });
    vi.stubGlobal('document', { title: 'Unidentifiable history entry' });
    capture.mockClear();

    try {
      Analytics.trackPageView(path);
      Analytics.trackPageView(path);

      const pageViews = capture.mock.calls.filter(([eventName]) => eventName === '$pageview');
      expect(pageViews).toHaveLength(2);
      expect(pageViews.every(([, params]) => !Object.prototype.hasOwnProperty.call(params, 'emission_id'))).toBe(true);
      const result = collapseTechnicalDuplicates(pageViews.map(([, params]) => ({
        event: '$pageview',
        observed: 1,
        emissionId: params.emission_id || '',
      })));
      expect(result).toMatchObject({ observed: 2, removed: 0, dedupUnavailable: 2 });
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not time-debounce a retry that carries the same emission id', async () => {
    const { captureEvent } = await import('@/services/posthog');
    const capture = vi.mocked(captureEvent);
    const path = '/offerte-di-lavoro-ticino/rapid-page-view-retry/';
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(4_000).mockReturnValueOnce(4_200);
    let historyState: Record<string, unknown> = { route: { entry: 'same' } };
    const historyRef = {
      length: 1,
      get state() { return historyState; },
      replaceState: vi.fn((nextState: Record<string, unknown>) => { historyState = nextState; }),
      pushState: vi.fn(),
    };
    vi.stubGlobal('window', {
      location: { origin: 'https://example.test', pathname: path },
      history: historyRef,
    });
    vi.stubGlobal('document', { title: 'Rapid page-view retry' });
    capture.mockClear();

    try {
      const { Analytics } = await reloadAnalyticsHelpers();
      Analytics.trackPageView(path);
      Analytics.trackPageView(path);

      const pageViews = capture.mock.calls.filter(([eventName]) => eventName === '$pageview');
      expect(pageViews).toHaveLength(2);
      expect(pageViews[1][1].emission_id).toBe(pageViews[0][1].emission_id);
      const result = collapseTechnicalDuplicates(pageViews.map(([, params]) => ({
        event: '$pageview',
        observed: 1,
        emissionId: params.emission_id || '',
      })));
      expect(result).toMatchObject({ observed: 1, removed: 1, dedupUnavailable: 0 });
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('uses the same canonical identity for job_apply instead of a display-name route slug', () => {
    const applyBlock = jobBoardSource.match(
      /const trackPublisherApplySignals = \(job: JobListing[\s\S]*?return eventId;/,
    );
    expect(applyBlock).not.toBeNull();
    expect(applyBlock![0]).toMatch(/\.\.\.buildJobApplyAttributionParams\(job\)/);
    expect(applyBlock![0]).not.toMatch(/job\.slug \|\| job\.id/);
    expect(applyBlock![0]).not.toMatch(/employer_key: canonicalCompanyRouteSlug/);
  });
});
