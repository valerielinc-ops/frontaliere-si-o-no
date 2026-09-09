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
    expect(uiStateSource).toMatch(
      /if \(!deferAttributionPageView\(initialPath\)\) Analytics\.trackPageView\(initialPath\)/,
    );
    expect(uiStateSource).toMatch(
      /if \(!deferAttributionPageView\(path\)\) Analytics\.trackPageView\(path\)/,
    );
  });

  it('uses the same canonical identity for job_apply instead of a display-name route slug', () => {
    const applyBlock = jobBoardSource.match(
      /const trackPublisherApplySignals = \(job: JobListing[\s\S]*?return eventId;/,
    );
    expect(applyBlock).not.toBeNull();
    expect(applyBlock![0]).toMatch(/const identity = resolveAnalyticsJobIdentity\(job\)/);
    expect(applyBlock![0]).toMatch(/employer_key: identity\?\.employerKey \|\| 'unknown'/);
    expect(applyBlock![0]).toMatch(/job_slug: identity\?\.jobSlug \|\| job\.slug \|\| job\.id/);
    expect(applyBlock![0]).not.toMatch(/employer_key: canonicalCompanyRouteSlug/);
  });
});
