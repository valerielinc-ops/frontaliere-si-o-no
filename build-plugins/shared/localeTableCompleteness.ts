/**
 * Generic completeness checker for hand-authored `Record<Locale, Record<Key,
 * string>>` lookup tables that feed canonical/indexed URL slugs.
 *
 * Every one of these tables carries a precise TypeScript type
 * (`Record<SomeLocale, Record<SomeKey, string>>`) that WOULD reject a
 * missing per-locale entry at compile time — but `npm run build` runs `vite
 * build`, which transpiles via esbuild and never runs `tsc` (no
 * `typecheck` script exists in this repo), so the type annotation is never
 * actually enforced at build time. A missing/blank entry silently ships and
 * a direct `TABLE[locale][key]` lookup embeds the literal string
 * `"undefined"` into an otherwise-valid canonical/indexed URL path — a GSC
 * 404/soft-404 (issue #3608 item 2, adversarial review on PR #3594).
 *
 * Extracted as a shared generic (rather than one copy-pasted checker per
 * table family) per the sibling-pattern discipline: `jobSectorLanding.ts`
 * (`SECTOR_HUB_SLUG`/`SECTOR_HUB_DISPLAY`), `seoHubsData.ts`
 * (`HUB_SLUG_BY_LOCALE`), `nursingLandingsData.ts`
 * (`NURSING_LANDING_SLUGS`), `healthPremiumsData.ts`
 * (`HEALTH_PREMIUM_CANTON_SLUG`, `HEALTH_PREMIUM_AGE_SLUG`),
 * `fuelDailyData.ts` (`FUEL_SECTION_SLUG`) and `professionLandingsData.ts`
 * (`PROFESSION_SLUGS`) all share this exact shape and risk — see
 * `build-plugins/localeTableCompletenessPlugin.ts` for the single
 * `closeBundle()` wiring point that asserts all of them.
 *
 * Node-only: callers must invoke `assertLocaleTablesComplete` from a
 * build-plugin hook (`closeBundle`, etc.), never at module-import time —
 * several of the tables backed by this checker live in files that are also
 * imported by the client bundle, and a thrown error at import time would
 * crash the live app for every visitor instead of just failing the build.
 */

/** A `Record<Locale, Record<Key, string>>`-shaped table, tolerant of gaps for the checker's own use. */
export type LocaleTable<Locale extends string, Key extends string> = Partial<
  Record<Locale, Partial<Record<Key, string>>>
>;

/**
 * Returns `"tableName.locale.key"` for every entry across `tables` that is
 * missing, `undefined`, or an empty/whitespace string.
 */
export function findMissingLocaleTableEntries<Locale extends string, Key extends string>(
  tables: ReadonlyArray<readonly [string, LocaleTable<Locale, Key>]>,
  locales: readonly Locale[],
  keys: readonly Key[],
): string[] {
  const missing: string[] = [];
  for (const [tableName, table] of tables) {
    for (const locale of locales) {
      for (const key of keys) {
        const value = table[locale]?.[key];
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${tableName}.${locale}.${key}`);
        }
      }
    }
  }
  return missing;
}

/**
 * Throws when any table in `tables` has a missing/blank entry for any
 * (locale, key) pair. `label` identifies the caller in the error message
 * (e.g. the source file / feature family).
 */
export function assertLocaleTablesComplete<Locale extends string, Key extends string>(
  label: string,
  tables: ReadonlyArray<readonly [string, LocaleTable<Locale, Key>]>,
  locales: readonly Locale[],
  keys: readonly Key[],
): void {
  const missing = findMissingLocaleTableEntries(tables, locales, keys);
  if (missing.length > 0) {
    throw new Error(
      `[${label}] ${missing.length} incomplete locale-table entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')} — ` +
        'a missing entry renders a literal "undefined" segment in a canonical URL (GSC 404 leak).',
    );
  }
}
