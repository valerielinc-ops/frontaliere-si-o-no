import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '..', 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard category pages — results-first ordering', () => {
  it('keeps the initial listing paint in the final shell while jobs resolve', () => {
    const loadingStart = source.indexOf('if (jobsLoading) {');
    const loadingEnd = source.indexOf('const authPendingNoticeJsx', loadingStart);
    const loadingBlock = source.slice(loadingStart, loadingEnd);
    const resolvingStart = source.indexOf('const resultsResolving =');

    expect(loadingStart).toBeGreaterThanOrEqual(0);
    expect(loadingEnd).toBeGreaterThan(loadingStart);
    expect(loadingBlock).not.toContain('if (!companySlugFilter) {');
    expect(loadingBlock).not.toContain('<JobBoardResultsLoader');
    expect(loadingBlock).toContain('if (companySlugFilter) {');
    expect(loadingBlock).toContain('<JobBoardRailShell isDesktopLg={isDesktopLg}>');
    expect(source.slice(resolvingStart, resolvingStart + 180)).toMatch(
      /const resultsResolving =\s*\(?\s*\(?\s*jobsLoading\s*\|\|/,
    );
  });

  it('reserves the first-page ad footprint before the real cards mount', () => {
    expect(source).toContain('const loadingInfeedAdSlots = resultsResolving && isUnfilteredListing && loadingCardCount > 0');
    expect(source).toContain('const loadingCardCount = isUnfilteredListing');
    expect(source).toContain('isCanonicalFirstPageListing && jobsLoading && filteredJobs.length === 0');
    expect(source).toContain('? pageSize');
    expect(source).toContain(': Math.min(pageSize, filteredJobs.length)');
    expect(source).toContain('cards={loadingCardCount}');
    expect(source).toContain('Array.from({ length: loadingCardCount }');
    expect(source).toContain('.filter((position) => position < loadingCardCount)');
    expect(source).toContain('infeedAdSlots={loadingInfeedAdSlots}');
    expect(source).toContain('(filteredJobs.length > 0 || (resultsResolving && isUnfilteredListing))');
  });

  it('does not reserve a full first page when the unfiltered result is short or empty', () => {
    const loadingCountStart = source.indexOf('const loadingCardCount =');
    const loadingCountEnd = source.indexOf('const isUsingSearchFallback', loadingCountStart);
    const loadingCountBlock = source.slice(loadingCountStart, loadingCountEnd);

    expect(loadingCountStart).toBeGreaterThanOrEqual(0);
    expect(loadingCountEnd).toBeGreaterThan(loadingCountStart);
    expect(loadingCountBlock).toContain('Math.min(pageSize, filteredJobs.length)');
  });

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
    const tapTargetClasses = source.match(/className="[^"]*min-h-11[^"]*"/g) ?? [];
    expect(tapTargetClasses.some((classes) => (
      classes.includes('text-xs')
      && classes.includes('font-medium')
      && classes.includes('rounded-full')
      && classes.includes('border')
    ))).toBe(true);
  });
});
