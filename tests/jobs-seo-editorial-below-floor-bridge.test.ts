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

  it('no longer defines a per-canton sector-hub below-floor bridge — the sector-hub floor was removed entirely (owner decision 2026-07-16, PR #4254 follow-up)', () => {
    expect(source).not.toContain('const emitSectorHubBelowFloorBridge');
    expect(source).not.toContain('emitSectorHubBelowFloorBridge(locale, canton, SECTOR_HUB_SLUG[locale][sector]);');
  });

  it('does not contain the bare-continue 404 bug pattern for the sector-hub canton floor', () => {
    expect(source).not.toContain('if (cantonTotal < MIN_JOBS_FOR_CANTON_PAGE) continue;');
  });

  it('defines the per-canton company and company×city below-floor bridge helpers and wires them in (#3747)', () => {
    expect(source).toContain('const emitCompanyCantonBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', canton: string, fullSlug: string): void => {');
    expect(source).toContain('emitCompanyCantonBelowFloorBridge(locale, canton, `${companyRoutePrefix[locale]}-${cSlug}`);');
    expect(source).toContain('const emitCompanyCityBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', canton: string, fullSlug: string): void => {');
    expect(source).toContain('emitCompanyCityBelowFloorBridge(locale, canton, `${companyRoutePrefix[locale]}-${cSlug}-${citySlug}`);');
  });

  it('does not contain the bare-continue 404 bug pattern for the per-sector/company/company-city floors (#3747)', () => {
    expect(source).not.toContain('if (sJobs.length < MIN_JOBS_PER_CANTON_SECTOR) continue;');
    expect(source).not.toContain('if (companyJobs.length < MIN_JOBS_PER_CANTON_COMPANY) continue;');
    expect(source).not.toContain('if (ccJobs.length < MIN_JOBS_PER_CANTON_COMPANY_CITY) continue;');
  });

  it('every below-floor bridge points at the canton-root hub section via buildCantonAwareSection, matching the unconditionally-emitted canton hub', () => {
    for (const helperStart of [
      "const emitEditorialBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, slug: string): void => {",
      "const emitCompanyCantonBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, fullSlug: string): void => {",
      "const emitCompanyCityBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', canton: string, fullSlug: string): void => {",
    ]) {
      const startIdx = source.indexOf(helperStart);
      expect(startIdx).toBeGreaterThan(-1);
      const body = source.slice(startIdx, startIdx + 800);
      expect(body).toContain('buildCantonAwareSection(locale, canton)');
      expect(body).toContain('noindex: true');
    }
  });

  it('defines the TI location/type/sector below-floor bridge helpers and wires them into every floor-check site', () => {
    expect(source).toContain('const emitLocationBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', loc: string): void => {');
    expect(source).toContain('const emitLocationTypeBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', loc: string, typeKeyArg: (typeof editorialTypeKeys)[number]): void => {');
    expect(source).toContain('const emitLocationSectorBelowFloorBridge = (locale: \'it\' | \'en\' | \'de\' | \'fr\', loc: string, sectorKeyArg: (typeof editorialSectorKeys)[number]): void => {');
    expect(source).toContain('emitLocationBelowFloorBridge(locale, location);');
    expect(source).toContain('emitLocationTypeBelowFloorBridge(locale, location, typeKey);');
    expect(source).toContain('emitLocationSectorBelowFloorBridge(locale, location, sectorKey);');
  });

  it('does not contain the bare-continue 404 bug pattern for the TI location/type/sector floors', () => {
    expect(source).not.toContain('if (italianLocationModel.totalJobs === 0) continue;');
    expect(source).not.toContain('if (italianTypeModel.totalJobs === 0) continue;');
    expect(source).not.toContain('if (italianSectorModel.totalJobs === 0) continue;');
  });

  it('location-level below-floor bridge dual-writes both the clean city-hub URL and the legacy editorial URL when they differ', () => {
    const startIdx = source.indexOf("const emitLocationBelowFloorBridge = (locale: 'it' | 'en' | 'de' | 'fr', loc: string): void => {");
    expect(startIdx).toBeGreaterThan(-1);
    const body = source.slice(startIdx, startIdx + 1400);
    expect(body).toContain('buildCityHubPath(locale, cityHubKey)');
    expect(body).toContain("if (!cityHubKey || legacyPath !== buildCityHubPath(locale, cityHubKey)) writeLocationFamilyBridge(legacyPath, targetPath, locale);");
  });

  it('location/type/sector bridges all route through the shared writer with noindex canonical-bridge pages', () => {
    expect(source).toContain('const writeLocationFamilyBridge = (canonicalPath: string, targetPath: string, locale: \'it\' | \'en\' | \'de\' | \'fr\'): void => {');
    const startIdx = source.indexOf('const writeLocationFamilyBridge = ');
    const body = source.slice(startIdx, startIdx + 700);
    expect(body).toContain('noindex: true');
  });

  // #3608 item 3 (adversarial follow-up on #3594): does BUILD_LOCALE shard
  // filtering leave a silent gap for any of these below-floor bridges? The
  // real safety net is path-based (_qw → collector.add → shouldEmitPath on
  // the computed dist path, see tests/below-floor-bridge-locale-shard.test.ts
  // for an end-to-end proof against the three emitters that ARE invocable
  // outside a full build), but every one of these 9 in-plugin call sites
  // also carries its own explicit `shouldEmitLocale` gate. These two tests
  // lock in that (a) the gate is never dropped and (b) it always gates the
  // SAME `locale` identifier that is passed to the bridge call — a
  // regression here (e.g. a copy-paste that gates `locale` but emits for a
  // different loop variable) would silently render/write a bridge the
  // shard doesn't own, wasted work today and a latent bug if the path-based
  // backstop were ever weakened.
  it('every below-floor bridge call site is immediately gated by shouldEmitLocale on the SAME locale identifier', () => {
    const callPatterns = [
      'emitEditorialBelowFloorBridge(locale, editorialCanton,',
      'emitLocationBelowFloorBridge(locale, location);',
      'emitLocationTypeBelowFloorBridge(locale, location, typeKey);',
      'emitLocationSectorBelowFloorBridge(locale, location, sectorKey);',
      'emitCompanyCantonBelowFloorBridge(locale, canton,',
      'emitCompanyCityBelowFloorBridge(locale, canton,',
    ];
    const expectedCallSiteCounts: Record<string, number> = {
      'emitEditorialBelowFloorBridge(locale, editorialCanton,': 5,
      'emitLocationBelowFloorBridge(locale, location);': 1,
      'emitLocationTypeBelowFloorBridge(locale, location, typeKey);': 1,
      'emitLocationSectorBelowFloorBridge(locale, location, sectorKey);': 1,
      // Per-canton company hub / company×city hub floors (#3747). The
      // sector-hub floor (and its bridge) was removed entirely (owner
      // decision 2026-07-16, PR #4254 follow-up) — no call sites left.
      'emitCompanyCantonBelowFloorBridge(locale, canton,': 1,
      'emitCompanyCityBelowFloorBridge(locale, canton,': 1,
    };
    for (const pattern of callPatterns) {
      let idx = source.indexOf(pattern);
      let found = 0;
      while (idx !== -1) {
        found++;
        const windowStart = Math.max(0, idx - 300);
        const before = source.slice(windowStart, idx);
        expect(
          before,
          `call site at offset ${idx} for "${pattern}" must be immediately preceded by "if (!shouldEmitLocale(locale)) continue;"`,
        ).toContain('if (!shouldEmitLocale(locale)) continue;');
        idx = source.indexOf(pattern, idx + pattern.length);
      }
      expect(found, `expected call-site count for "${pattern}"`).toBe(expectedCallSiteCounts[pattern]);
    }
  });

  it('the shared _qw writer funnels every below-floor bridge write through collector.add (the real shard-locale chokepoint), never a raw fs write', () => {
    const startIdx = source.indexOf('function _qw(filePath: string, content: string) {');
    expect(startIdx).toBeGreaterThan(-1);
    const body = source.slice(startIdx, startIdx + 300);
    expect(body).toContain('collector.add(');
    expect(body).not.toContain('fs.writeFileSync(');
  });
});
