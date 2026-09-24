import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '..', 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard category pages — results-first ordering', () => {
  it('mounts secondary discovery utilities once, after the first three available jobs', () => {
    expect(source).toContain('const postFirstResultsUtilities =');
    expect(source).toContain('const utilitiesAfterPosition = Math.min(3, displayJobs.length);');
    expect(source).toContain('!resultsResolving && pos === utilitiesAfterPosition && postFirstResultsUtilities');
    expect(source).toContain('displayJobs.length === 0 && !resultsResolving && postFirstResultsUtilities');

    expect(source.match(/<PopularSearchChips\b/g)).toHaveLength(1);
    expect(source.match(/<JobAlertForm\b/g)).toHaveLength(1);
  });

  it('keeps only the time-and-location quick row before the filter toggle', () => {
    const returnStart = source.indexOf('<JobBoardRailShell');
    const firstRow = source.indexOf('Time & Location', returnStart);
    const filterToggle = source.indexOf('Filter toggle bar', returnStart);
    const secondRowMount = source.indexOf('postFirstResultsUtilities', filterToggle);

    expect(firstRow).toBeGreaterThan(returnStart);
    expect(filterToggle).toBeGreaterThan(firstRow);
    expect(secondRowMount).toBeGreaterThan(filterToggle);
  });

  it('keeps the category/sector alert CTA before the first result', () => {
    const alertRender = source.indexOf('{boardFilterAlertCtaJsx}');
    const firstResult = source.indexOf('{displayJobs.map((job, idx) => {');

    expect(alertRender).toBeGreaterThan(-1);
    expect(firstResult).toBeGreaterThan(alertRender);
    expect(source).toContain("context={boardFilterAlertContext}");
    expect(source).toContain("userId={userId}");
    expect(source).toContain("onAnonymousOpen={() => {");
  });

  it('keeps the first job link and filter CTA on mobile-sized tap targets', () => {
    expect(source).toContain('className="block min-h-[44px] cursor-pointer');
    expect(source).toContain('min-h-11 text-xs font-medium rounded-full border');
  });

  it('keeps filter and card navigation work out of the urgent interaction lane', () => {
    const adRefreshStart = source.indexOf('startTransition(() => setAdRefreshKey');
    const filterEffectStart = source.lastIndexOf('useEffect(() => {', adRefreshStart);
    const filterEffect = source.slice(filterEffectStart, source.indexOf('}, [deferredSearchQuery', filterEffectStart));
    expect(filterEffect).toContain('startTransition(() => setAdRefreshKey((k) => k + 1));');

    const openDetailStart = source.indexOf('const openDetail = useCallback(');
    const openDetailEnd = source.indexOf('const renderJobCard =', openDetailStart);
    const openDetail = source.slice(openDetailStart, openDetailEnd);
    expect(openDetail).toContain('startTransition(() => {');
    expect(openDetail).toContain('onJobRouteChange?.(deriveLocalizedJobSlug(job, locale), resolveJobCanton(job));');
    expect(openDetail).toContain('}, [authResolved, behaviorData, enablePersonalization, jobMatchProfile, locale, onJobRouteChange, page, searchQuery, userProfile]);');
  });
});
