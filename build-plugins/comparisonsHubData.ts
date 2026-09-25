/**
 * Comparisons Hub (AE-7) — slug tables, routes, aggregation helpers.
 *
 * One-of-a-kind static landing with dense cross-border comparison tables
 * (salary, tax, healthcare, benefits, cost of living) targeted at LLM
 * citations + high-intent SEO.
 *
 * Canonical paths (one per locale):
 *   IT:  /confronti-frontalieri/
 *   EN:  /en/cross-border-comparisons/
 *   DE:  /de/grenzgaenger-vergleich/
 *   FR:  /fr/comparaisons-frontaliers/
 *
 * The router consumes {@link COMPARISONS_HUB_ROUTES} +
 * {@link parseComparisonsHubPath} to resolve these URLs to a
 * `staticOverlay` SPA route so the build-time static HTML emitted by
 * `comparisonsHubPlugin.ts` stays visible outside `#root` and the SPA
 * doesn't replace it with a generic sub-tab view on hydrate.
 *
 * Kept standalone (no dep on staticPagesPlugin etc.) so parallel
 * worktrees merge cleanly — same pattern as nursingLandingsPlugin.
 */

// NOTE: this module is imported by `services/router.ts` (client bundle).
// It MUST stay pure-TypeScript: no `node:fs` / `node:path` / `process`.
// The build-time aggregations (salary + LAMal canton medians) live in
// `./comparisonsHubAggregate.ts`, which is only imported by the Vite plugin.

export const COMPARISONS_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ComparisonsLocale = (typeof COMPARISONS_LOCALES)[number];

export const COMPARISONS_LOCALE_PREFIX: Record<ComparisonsLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Per-locale slug for the hub. Italian canonical has no prefix. */
export const COMPARISONS_HUB_SLUG: Record<ComparisonsLocale, string> = {
  it: 'confronti-frontalieri',
  en: 'cross-border-comparisons',
  de: 'grenzgaenger-vergleich',
  fr: 'comparaisons-frontaliers',
};

export function buildComparisonsHubPath(locale: ComparisonsLocale): string {
  const prefix = COMPARISONS_LOCALE_PREFIX[locale];
  const slug = COMPARISONS_HUB_SLUG[locale];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

/** Flat list of every canonical (4 locales). */
export const COMPARISONS_HUB_ROUTES: readonly string[] = COMPARISONS_LOCALES.map(
  (loc) => buildComparisonsHubPath(loc),
);

/**
 * Resolve a pathname to a comparisons-hub match or `null`. Accepts paths
 * with or without trailing slash.
 */
export function parseComparisonsHubPath(
  pathname: string,
): { locale: ComparisonsLocale } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of COMPARISONS_LOCALES) {
    if (buildComparisonsHubPath(locale) === normalized) return { locale };
  }
  return null;
}

export function isComparisonsHubPath(pathname: string): boolean {
  return parseComparisonsHubPath(pathname) !== null;
}
