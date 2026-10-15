/**
 * Test-only exports for costOfLivingLandingsPlugin.
 *
 * Extracted from costOfLivingLandingsPlugin.ts to keep that file below the
 * 800-line guideline. Production code never imports from this file — it is
 * consumed only by tests/build-plugins/ that need to call the rendering
 * helpers without invoking the full Vite plugin build path.
 *
 * The two helpers are re-exported from costOfLivingLandingsPlugin.ts so
 * existing import paths in test files continue to work unchanged.
 */

import {
  COL_CITY_DISPLAY,
  type ColLocale,
  type ColCityId,
} from './costOfLivingLandingsData';
import {
  getLocaleStrings,
} from './costOfLivingLandingsCopy';
import {
  renderFeaturedJobs,
  renderEmployerGrid,
  type CityCopyView,
} from './costOfLivingLandingsPlugin';
import type { CityJobsSnapshot } from './cityJobsAggregate';

/** Exported for unit tests — builds minimal view and delegates to renderEmployerGrid. */
export function renderCostOfLivingEmployerGridForTest(
  cityId: ColCityId,
  locale: ColLocale,
  snapshot: { topEmployers: ReadonlyArray<{ name: string; count: number }> },
): string {
  const L = getLocaleStrings(locale);
  const cityName = COL_CITY_DISPLAY[cityId][locale];
  const view: CityCopyView = {
    statTileSalaryLabel: '',
    statTileRentLabel: '',
    statTileLiveJobsLabel: '',
    statSalaryFmt: () => '',
    statRentFmt: () => '',
    statLiveJobsFmt: () => '',
    primaryCtaLabel: '',
    featuredJobsTitle: '',
    featuredJobsCtaAll: '',
    featuredJobsEmpty: '',
    featuredFallbackBadge: '',
    employerGridTitle: L.employerGridTitle(cityName),
    approfondisciHeading: '',
    jobPostedLabel: () => '',
    jobSalaryFmt: () => '',
  };
  return renderEmployerGrid(snapshot as CityJobsSnapshot, view, locale, cityId);
}

// Test-only export: allows tests/build-plugins/job-card-canonical-adoption.test.ts
// to verify the migrated renderer emits canonical job-card markers.
export function renderCostOfLivingFeaturedJobsForTest(
  city: ColCityId,
  locale: ColLocale,
  snapshot: CityJobsSnapshot,
): string {
  const L = getLocaleStrings(locale);
  const cityName = COL_CITY_DISPLAY[city][locale];
  const view: CityCopyView = {
    statTileSalaryLabel: L.statTileSalaryLabel,
    statTileRentLabel: L.statTileRentLabel,
    statTileLiveJobsLabel: L.statTileLiveJobsLabel,
    statSalaryFmt: L.statSalaryFmt,
    statRentFmt: L.statRentFmt,
    statLiveJobsFmt: L.statLiveJobsFmt,
    primaryCtaLabel: L.primaryCtaLabel(cityName),
    featuredJobsTitle: L.featuredJobsTitle(cityName),
    featuredJobsCtaAll: L.featuredJobsCtaAll(cityName, snapshot.liveCount),
    featuredJobsEmpty: L.featuredJobsEmpty(cityName),
    featuredFallbackBadge: L.featuredFallbackBadge,
    employerGridTitle: L.employerGridTitle(cityName),
    approfondisciHeading: L.approfondisciHeading,
    jobPostedLabel: L.jobPostedLabel,
    jobSalaryFmt: L.jobSalaryFmt,
  };
  return renderFeaturedJobs(city, locale, snapshot, view);
}
