/**
 * Regression guard for free-text job-board searches.
 *
 * The static landing can only know the all-board count. Hydrated searches must
 * publish the filtered count in the live heading, result summary and title so
 * a query such as `?q=nurse` cannot continue to present the stale landing
 * number after the real result set has loaded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '..', 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard — filtered search count', () => {
  it('uses the free-text query in the hydrated hero when no search slug exists', () => {
    expect(source).toMatch(/const activeSearchHeadingQuery = searchHeadingQuery \|\| deferredSearchQuery\.trim\(\)/);
    expect(source).toMatch(/: activeSearchHeadingQuery\s*\n\s*\? t\('jobBoard\.searchPageTitle'/);
  });

  it('renders the authoritative filtered count in a live summary', () => {
    expect(source).toMatch(/data-testid="job-board-search-result-summary"/);
    expect(source).toMatch(/activeSearchHeadingQuery && !resultsResolving/);
    expect(source).toMatch(/t\('jobBoard\.resultsCount', \{ count: String\(filteredJobs\.length\) \}\)/);
  });

  it('updates document.title only after the filtered set settles and restores it on clear', () => {
    expect(source).toMatch(/document\.title = resultsResolving\s*\n\s*\? baseTitle/);
    expect(source).toMatch(/document\.title = originalListingTitleRef\.current/);
  });
});
