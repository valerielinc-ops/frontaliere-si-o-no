import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldRefreshInfeedAdsOnUrlRestore } from '../components/community/JobBoard';

const JOB_BOARD_SOURCE = readFileSync(
  resolve(__dirname, '../components/community/JobBoard.tsx'),
  'utf8',
);
const INSIGHTS_WORKFLOW = readFileSync(
  resolve(__dirname, '../.github/workflows/employer-insights-refresh.yml'),
  'utf8',
);

describe('JobBoard in-feed reservation on URL restore', () => {
  it('refreshes only for a page-only restore', () => {
    expect(shouldRefreshInfeedAdsOnUrlRestore('koch', 'koch', 1, 2)).toBe(true);
    expect(shouldRefreshInfeedAdsOnUrlRestore('koch', 'davos', 1, 2)).toBe(false);
    expect(shouldRefreshInfeedAdsOnUrlRestore('koch', 'koch', 1, 1)).toBe(false);
  });

  it('leaves query changes to the deferred-filter refresh owner', () => {
    const syncBlock = JOB_BOARD_SOURCE.slice(
      JOB_BOARD_SOURCE.indexOf('const syncFromUrl = () => {'),
      JOB_BOARD_SOURCE.indexOf('window.addEventListener(\'popstate\'', JOB_BOARD_SOURCE.indexOf('const syncFromUrl = () => {')),
    );
    expect(syncBlock).toContain('shouldRefreshInfeedAdsOnUrlRestore');
    expect(syncBlock).toMatch(
      /if \(shouldRefreshInfeedAdsOnUrlRestore\([\s\S]*?\)\) \{[\s\S]*?setAdRefreshKey\(\(k\) => k \+ 1\);/,
    );
  });

  it('refreshes before the detail-return page-reset guard exits', () => {
    const filterEffect = JOB_BOARD_SOURCE.slice(
      JOB_BOARD_SOURCE.indexOf('useEffect(() => {\n setAdRefreshKey((k) => k + 1);'),
      JOB_BOARD_SOURCE.indexOf('}, [deferredSearchQuery, selectedCategory'),
    );
    expect(filterEffect).toMatch(
      /setAdRefreshKey\(\(k\) => k \+ 1\);[\s\S]*if \(skipPageReset\.current\)/,
    );
  });

  it('keeps the crawler companyDomain raw for direct-apply ownership', () => {
    const normalizer = JOB_BOARD_SOURCE.slice(
      JOB_BOARD_SOURCE.indexOf('function normalizeIncomingJob'),
      JOB_BOARD_SOURCE.indexOf('function readSeededJob'),
    );
    expect(normalizer).toContain('const rawCompanyDomain = String(raw?.companyDomain || \'\').trim();');
    expect(normalizer).toContain('companyDomain: rawCompanyDomain || undefined');
    expect(normalizer).not.toContain('companyDomain: canonicalHost');
  });
});

describe('employer-insights checkout identity catalog', () => {
  it('does not sparse-exclude the two catalogs named by the builder contract', () => {
    expect(INSIGHTS_WORKFLOW).not.toContain('!/data/all-known-job-slugs/');
    expect(INSIGHTS_WORKFLOW).not.toContain('!/data/slug-registry.json');
  });
});
