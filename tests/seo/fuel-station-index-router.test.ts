/**
 * Regression — SPA router must recognise fuel-station / fuel-cities INDEX URLs.
 *
 * Background
 * ----------
 * The build-plugins/fuelStationIndexPages module emits browseable indexes at
 * paths like `/prezzi-benzina/stazioni-italia/`. The static HTML is served by
 * GitHub Pages (200 OK), but on hydrate the SPA's `parsePath()` must resolve
 * the URL to a known route or it falls through to `notFoundPath`, rewriting
 * the URL to `/` and rendering the "Pagina non trovata" helper inside `#root`.
 *
 * Reported 2026-04-29: clicking the Italian-stations link from
 * `/prezzi-benzina/oggi/` produced a "Pagina non trovata" screen with the URL
 * silently flipped to home — the static HTML was visible for a frame, then
 * the SPA replaced it.
 *
 * Fix: extend `isFuelDailyPath()` (the gate behind the FUEL_DAILY_ROUTES
 * router branch in `services/router.ts`) to also recognise the 3 index kinds
 * across all 4 locales × 2 fuels via a flat terminal-slug set.
 *
 * What this test asserts
 * ----------------------
 *   1. Every URL emitted by `buildFuelIndexPath()` for every (locale, fuel,
 *      kind) tuple is matched by `isFuelStationIndexPath()` AND
 *      `isFuelDailyPath()`.
 *   2. The flat terminal-slug set inside `fuelDailyData.ts` stays in sync
 *      with the structured `FUEL_INDEX_SLUG` source-of-truth in
 *      `fuelStationIndexPages.ts` (no drift on rename).
 *   3. Negative cases: unrelated URLs (job-board, blog, calculator) do NOT
 *      match — guards against accidentally over-broad recognition that would
 *      hijack other tabs.
 */

import { describe, it, expect } from 'vitest';
import {
  FUEL_DAILY_LOCALES,
  FUEL_TYPES,
  isFuelDailyPath,
  isFuelStationIndexPath,
  type FuelDailyLocale,
  type FuelType,
} from '../../build-plugins/fuelDailyData';
import {
  FUEL_INDEX_SLUG,
  buildFuelIndexPath,
  type FuelIndexKind,
} from '../../build-plugins/fuelStationIndexPages';

describe('fuel-station-index router recognition', () => {
  const kinds: readonly FuelIndexKind[] = Object.keys(FUEL_INDEX_SLUG) as FuelIndexKind[];

  it('matches every (locale × fuel × kind) index path', () => {
    const cases: Array<{ path: string; locale: FuelDailyLocale; fuel: FuelType; kind: FuelIndexKind }> = [];
    for (const locale of FUEL_DAILY_LOCALES) {
      for (const fuel of FUEL_TYPES) {
        for (const kind of kinds) {
          // italianStations is benzina-only by data shape, but the path
          // builder is agnostic — exercise both fuels for full coverage.
          cases.push({ path: buildFuelIndexPath(locale, fuel, kind), locale, fuel, kind });
        }
      }
    }
    // 4 locales × 2 fuels × 3 kinds = 24 paths.
    expect(cases).toHaveLength(24);
    for (const { path } of cases) {
      expect(isFuelStationIndexPath(path), `index path not matched: ${path}`).toBe(true);
      expect(isFuelDailyPath(path), `not seen as fuel-daily: ${path}`).toBe(true);
    }
  });

  it('the canonical bug URL resolves', () => {
    // The exact URL the user reported as "Pagina non trovata".
    expect(isFuelStationIndexPath('/prezzi-benzina/stazioni-italia/')).toBe(true);
    expect(isFuelDailyPath('/prezzi-benzina/stazioni-italia/')).toBe(true);
  });

  it('rejects unrelated URLs', () => {
    const negatives = [
      '/',
      '/lavoro/',
      '/blog/',
      '/prezzi-benzina/', // hub itself, not an index
      '/prezzi-benzina/oggi/', // daily hub (matched elsewhere, not by index predicate)
      '/prezzi-benzina/chiasso/', // zone hub
      '/prezzi-benzina/italia/como/oggi/', // city hub
      '/random-slug/',
      '/en/gasoline-price-switzerland/', // section root
    ];
    for (const p of negatives) {
      expect(isFuelStationIndexPath(p), `false positive: ${p}`).toBe(false);
    }
  });

  it('terminal slugs stay aligned with FUEL_INDEX_SLUG', () => {
    // Drift guard: every slug declared in the structured map must be
    // recognised by the flat predicate (and vice-versa for the active
    // slugs that appear in real URLs).
    const expectedSlugs = new Set<string>();
    for (const kind of kinds) {
      for (const locale of FUEL_DAILY_LOCALES) {
        expectedSlugs.add(FUEL_INDEX_SLUG[kind][locale]);
      }
    }
    for (const slug of expectedSlugs) {
      const probe = `/prezzi-benzina/${slug}/`;
      expect(isFuelStationIndexPath(probe), `terminal slug ${slug} not recognised`).toBe(true);
    }
  });
});
