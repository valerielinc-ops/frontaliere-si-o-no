/**
 * Single build-time wiring point that asserts every hand-authored
 * `Record<Locale, Record<Key, string>>` slug table used to build a
 * canonical/indexed URL is fully populated across every (locale, key) pair.
 *
 * Why this exists (issue #3608 item 2, adversarial review on PR #3594):
 * these tables carry a precise TypeScript type that WOULD reject a missing
 * entry at compile time, but `npm run build` runs `vite build` (esbuild
 * transpile, no `tsc`/typecheck step), so the annotation is never actually
 * enforced. A missing entry silently ships and a direct `TABLE[locale][key]`
 * lookup embeds the literal string `"undefined"` into an otherwise-valid
 * canonical/indexed URL path — a GSC 404/soft-404.
 *
 * `jobSectorLanding.ts` (`SECTOR_HUB_SLUG` / `SECTOR_HUB_DISPLAY`) already
 * wires its own `assertSectorHubTablesComplete()` inline into
 * `jobsSeoPagesPlugin.ts`'s `closeBundle()` (the original #3608 item 2 fix).
 * The sibling-pattern grep for the same construct across `build-plugins/**`
 * found six more tables sharing the exact same shape and direct-index
 * usage in URL construction:
 *   - seoHubsData.ts        → HUB_SLUG_BY_LOCALE
 *   - nursingLandingsData.ts → NURSING_LANDING_SLUGS
 *   - healthPremiumsData.ts  → HEALTH_PREMIUM_CANTON_SLUG, HEALTH_PREMIUM_AGE_SLUG
 *   - fuelDailyData.ts       → FUEL_SECTION_SLUG
 *   - professionLandingsData.ts → PROFESSION_SLUGS
 *   - cityJobsHub.ts         → CITY_HUB_SLUG
 * Rather than duplicating a bespoke assertion + closeBundle wiring per file
 * (seven near-identical copies), this plugin centralizes the check for all
 * six siblings behind the one shared generic in
 * `build-plugins/shared/localeTableCompleteness.ts`.
 *
 * Registered standalone in vite.config.ts (not inside another plugin's
 * closeBundle) since none of these six tables are owned by a single
 * feature plugin the way SECTOR_HUB_SLUG is owned by jobsSeoPagesPlugin.
 * Every table checked here is a build-plugins-only data module; none of
 * this file's imports are reachable from the client bundle, but the
 * assertion still only runs from `closeBundle()` (never at module-import
 * time) to match the safety convention used by `assertSectorHubTablesComplete`.
 */
import type { Plugin } from 'vite';
import { assertLocaleTablesComplete } from './shared/localeTableCompleteness';
import { HUB_SLUG_BY_LOCALE, HUB_LOCALES, type HubKind } from './seoHubsData';
import { NURSING_LANDING_SLUGS, NURSING_LOCALES, NURSING_LANDING_IDS } from './nursingLandingsData';
import {
  HEALTH_PREMIUM_CANTON_SLUG,
  HEALTH_PREMIUM_AGE_SLUG,
  HEALTH_PREMIUM_LOCALES,
  HEALTH_PREMIUM_CANTONS,
  HEALTH_PREMIUM_AGE_BRACKETS,
} from './healthPremiumsData';
import { FUEL_SECTION_SLUG, FUEL_DAILY_LOCALES, FUEL_TYPES } from './fuelDailyData';
import { PROFESSION_SLUGS, PROFESSION_LOCALES, PROFESSION_IDS } from './professionLandingsData';
import { CITY_HUB_SLUG, CITY_HUB_LOCALES, CITY_HUB_KEYS } from './cityJobsHub';

export function localeTableCompletenessPlugin(): Plugin {
  return {
    name: 'locale-table-completeness',
    apply: 'build',
    closeBundle() {
      assertLocaleTablesComplete(
        'seoHubsData',
        [['HUB_SLUG_BY_LOCALE', HUB_SLUG_BY_LOCALE]],
        HUB_LOCALES,
        ['tutti', 'settori', 'aziende'] satisfies readonly HubKind[],
      );

      assertLocaleTablesComplete(
        'nursingLandingsData',
        [['NURSING_LANDING_SLUGS', NURSING_LANDING_SLUGS]],
        NURSING_LOCALES,
        NURSING_LANDING_IDS,
      );

      assertLocaleTablesComplete(
        'healthPremiumsData',
        [['HEALTH_PREMIUM_CANTON_SLUG', HEALTH_PREMIUM_CANTON_SLUG]],
        HEALTH_PREMIUM_LOCALES,
        HEALTH_PREMIUM_CANTONS,
      );
      assertLocaleTablesComplete(
        'healthPremiumsData',
        [['HEALTH_PREMIUM_AGE_SLUG', HEALTH_PREMIUM_AGE_SLUG]],
        HEALTH_PREMIUM_LOCALES,
        HEALTH_PREMIUM_AGE_BRACKETS.map((b) => b.id),
      );

      assertLocaleTablesComplete(
        'fuelDailyData',
        [['FUEL_SECTION_SLUG', FUEL_SECTION_SLUG]],
        FUEL_DAILY_LOCALES,
        FUEL_TYPES,
      );

      assertLocaleTablesComplete(
        'professionLandingsData',
        [['PROFESSION_SLUGS', PROFESSION_SLUGS]],
        PROFESSION_LOCALES,
        PROFESSION_IDS,
      );

      assertLocaleTablesComplete(
        'cityJobsHub',
        [['CITY_HUB_SLUG', CITY_HUB_SLUG]],
        CITY_HUB_LOCALES,
        CITY_HUB_KEYS,
      );
    },
  };
}
