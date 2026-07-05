/**
 * Regression guard for the GSC Coverage Drilldown 404 sweep sibling bug class
 * in build-plugins/jobsSeoPagesPlugin.ts (same class already covered by
 * tests/profession-canton-landings.test.ts and
 * tests/ch-canton-below-floor-bridge.test.ts): a per-canton editorial page
 * used to silently `continue` past a canton once it fell under
 * MIN_JOBS_FOR_CANTON_PAGE (or, for the care-variant cluster, once it had
 * zero matching jobs), dropping a URL Google may already have indexed
 * straight to a GH Pages hard 404 with no bridge.
 *
 * jobsSeoPagesPlugin.ts is a single closeBundle()-hook Vite plugin that only
 * runs inside a full SSG build (RAM-bound, not invocable in a lightweight
 * unit test -- see tests/jobs-seo-pages-plugin.test.ts's own
 * "static payload budget" test for the established source-assertion pattern
 * this file uses in place of a full render). This test follows that same
 * convention: it asserts the below-floor bridge helpers exist and are wired
 * up at every known below-floor site, and that the old bare-`continue`
 * bug pattern has not been reintroduced.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

describe('jobsSeoPagesPlugin editorial-canton below-floor bridges', () => {
  it('defines the shared editorial below-floor bridge helper', () => {
    expect(source).toContain('const emitEditorialBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', canton: string, slug: string): void => {');
  });

  it('wires the bridge helper into every editorial-canton floor-check site', () => {
    const expectedSlugGetters = [
      'getJobTodayLandingSlug(locale, editorialCanton)',
      'getJobNursesHubSlug(locale, editorialCanton)',
      'getJobPartTimeLandingSlug(locale, editorialCanton)',
    ];
    for (const slugGetter of expectedSlugGetters) {
      expect(source).toContain(`emitEditorialBelowFloorBridge(locale, editorialCanton, ${slugGetter});`);
    }
    // Care-variant has two distinct below-floor sites (the shared canton
    // floor-check and the cluster-specific zero-jobs check) that both bridge
    // via the same careClusterSlug(...) call -- both must be wired.
    const careCallSites = source.split('emitEditorialBelowFloorBridge(locale, editorialCanton, careClusterSlug(clusterKey, editorialCanton, locale));').length - 1;
    expect(careCallSites).toBe(2);
  });

  it('does not contain the bare bare-continue 404 bug pattern for editorial-canton floors', () => {
    expect(source).not.toContain('(editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) continue;');
    expect(source).not.toContain('if (italianCareModel.totalJobs === 0) continue;');
  });

  it('defines the per-canton sector-hub below-floor bridge helper and wires it in', () => {
    expect(source).toContain('const emitSectorHubBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', canton: string, slug: string): void => {');
    expect(source).toContain('emitSectorHubBelowFloorBridge(locale, canton, SECTOR_HUB_SLUG[locale][sector]);');
  });

  it('does not contain the bare-continue 404 bug pattern for the sector-hub canton floor', () => {
    expect(source).not.toContain('if (cantonTotal < MIN_JOBS_FOR_CANTON_PAGE) continue;');
  });

  it('every below-floor bridge points at the canton-root hub section via buildCantonAwareSection, matching the unconditionally-emitted canton hub', () => {
    for (const helperStart of [
      "const emitEditorialBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, slug: string): void => {",
      "const emitSectorHubBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, slug: string): void => {",
    ]) {
      const startIdx = source.indexOf(helperStart);
      expect(startIdx).toBeGreaterThan(-1);
      const body = source.slice(startIdx, startIdx + 800);
      expect(body).toContain('buildCantonAwareSection(locale, canton)');
      expect(body).toContain('noindex: true');
    }
  });
});
