import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const loadAnalyticsHelpers = async () => vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
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
      'getPageViewEmissionId(path, currentPageViewEmission)',
    );
    const { getPageViewEmissionId } = await loadAnalyticsHelpers();
    const path = '/offerte-di-lavoro-ticino/async-page-view/';
    const first = getPageViewEmissionId(path, null);
    const retry = getPageViewEmissionId(path, { path, emissionId: first });
    const nextRoute = getPageViewEmissionId('/offerte-di-lavoro-ticino/next/', {
      path,
      emissionId: first,
    });

    expect(retry).toBe(first);
    expect(nextRoute).not.toBe(first);
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
