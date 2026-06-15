/**
 * Per-locale comparator cross-link paths — LEAF module, zero imports.
 *
 * Single source of truth for the FX / health-insurance / fuel comparator
 * cross-links emitted in canton SEO prose, snapshot prose, bridge prose, job
 * listing prose and the commuter context. Mirror of shared/calcHref.ts (the
 * calculator SSOT from #1948/#1994).
 *
 * WHY a leaf (zero imports): the same modules that consume this form an import
 * cycle (jobBoardCommuterContext → cantonSeoProse → … ). If this table lived in
 * one of them, the esbuild-bundled vite.config graph would evaluate the table to
 * `undefined` at a consumer's module-init and crash the FULL build (the #1938
 * calcHref incident). A leaf makes the cycle impossible by construction.
 *
 * WHY it exists (#1997): the comparator hrefs were hard-coded and duplicated
 * across five or more prose modules and DRIFTED into a dead orphan scheme — `/en/comparators/…`,
 * `/de/vergleiche/…`, `/fr/comparateurs/…` — that NO plugin emits (404 on
 * indexed pages, link-equity loss). The real comparator pages are emitted (and
 * curl-verified 200) at the `/{…}/service-comparison/…` (EN) /
 * `service-vergleich` (DE) / `comparaison-services` (FR) scheme — see the
 * authoritative section slugs in shared/hubChrome.ts. These values are the
 * direct canonical targets (no 301-redirect hop): IT FX points straight at
 * `/compara-servizi/cambio-franco-euro/`, not the `/comparatori/cambio-valuta/`
 * bridge.
 */

export type ComparatorHrefLocale = 'it' | 'en' | 'de' | 'fr';

/** Currency-exchange (CHF/EUR) comparator. curl-verified 200 (2026-06-15). */
export const FX_HREF: Record<ComparatorHrefLocale, string> = {
  it: '/compara-servizi/cambio-franco-euro/',
  en: '/en/service-comparison/chf-eur-exchange-rate/',
  de: '/de/service-vergleich/chf-eur-wechselkurs/',
  fr: '/fr/comparaison-services/taux-change-chf-eur/',
};

/** Health-insurance (LAMal) comparator. curl-verified 200 (2026-06-15). */
export const HEALTH_HREF: Record<ComparatorHrefLocale, string> = {
  it: '/compara-servizi/confronta-casse-malati/',
  en: '/en/service-comparison/compare-health-insurance/',
  de: '/de/service-vergleich/krankenkassen-vergleichen/',
  fr: '/fr/comparaison-services/comparer-caisses-maladie/',
};

/** Job-offers comparator. Slugs composed from the authoritative `confronti` +
 * `jobs` keys in shared/hubChrome.ts HUB_SLUGS (same scheme as FX/HEALTH); IT/EN
 * mirror the already-live CTAs. DE leaf is `stellenangebote-vergleichen`, NOT the
 * orphan `jobangebote-vergleichen` that the pre-SSOT CTAs had drifted onto. */
export const JOBS_HREF: Record<ComparatorHrefLocale, string> = {
  it: '/compara-servizi/confronta-offerte-lavoro/',
  en: '/en/service-comparison/compare-job-offers/',
  de: '/de/service-vergleich/stellenangebote-vergleichen/',
  fr: '/fr/comparaison-services/comparer-offres-emploi/',
};

/** Fuel-price tracker. curl-verified 200 (2026-06-15) — note the per-locale
 * "today" leaf segment; the bare `/…/gasoline-price-switzerland/` form 404s. */
export const FUEL_HREF: Record<ComparatorHrefLocale, string> = {
  it: '/prezzi-benzina/oggi/',
  en: '/en/gasoline-price-switzerland/today/',
  de: '/de/benzinpreis-schweiz/heute/',
  fr: '/fr/prix-essence-suisse/aujourd-hui/',
};
