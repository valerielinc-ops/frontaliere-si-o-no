/**
 * Browser-safe URL builders for the CHF/EUR exchange SSG vertical (epic #4452).
 *
 * ONE definition of section slugs / curated amount set / path builders, shared
 * by:
 *   - build-plugins/exchangeRateSsgData.ts (build-time re-export; adds the
 *     node:fs snapshot loader + precompiled compat Set)
 *   - SPA components (calculator ResultsView internal link) — this module has
 *     NO node imports so it is safe in the client bundle.
 *
 * Trailing slash everywhere (site canonical convention).
 */

export type ExchangeLocale = 'it' | 'en' | 'de' | 'fr';

export const EXCHANGE_LOCALES: readonly ExchangeLocale[] = ['it', 'en', 'de', 'fr'];

export const EXCHANGE_LOCALE_PREFIX: Record<ExchangeLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Top-level section slug per locale. NOTE: the IT slug intentionally matches
 * the SPA comparator sub-tab wording ("cambio-franco-euro") but lives at the
 * ROOT (`/cambio-franco-euro/`), distinct from the SPA route
 * `/compara-servizi/cambio-franco-euro/` — issue #4453 mandates the root URL.
 */
export const EXCHANGE_SECTION_SLUG: Record<ExchangeLocale, string> = {
  it: 'cambio-franco-euro',
  en: 'chf-eur-exchange',
  de: 'franken-euro-kurs',
  fr: 'change-franc-euro',
};

/**
 * Curated amount set (CHF) — typical frontaliere gross monthly salaries plus
 * a few round query-magnet values ("4000 franchi in euro"). ~20 values by
 * design (issue #4454: "set curato ~15-25 importi, non prodotto cartesiano").
 * Every amount page is emitted UNCONDITIONALLY (static copy, no data floor),
 * so no below-floor bridge is needed for this family.
 */
export const EXCHANGE_AMOUNTS: readonly number[] = [
  1000, 1500, 2000, 2500, 3000, 3200, 3500, 3800, 4000, 4200,
  4500, 4800, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 10000,
];

/** Per-locale amount slug, e.g. IT `4000-franchi-in-euro`. */
export function exchangeAmountSlug(locale: ExchangeLocale, amount: number): string {
  switch (locale) {
    case 'it':
      return `${amount}-franchi-in-euro`;
    case 'en':
      return `${amount}-chf-to-eur`;
    case 'de':
      return `${amount}-franken-in-euro`;
    case 'fr':
      return `${amount}-francs-en-euros`;
  }
}

/** Hub path with trailing slash, e.g. `/cambio-franco-euro/`. */
export function buildExchangeHubPath(locale: ExchangeLocale): string {
  return `${EXCHANGE_LOCALE_PREFIX[locale]}/${EXCHANGE_SECTION_SLUG[locale]}/`;
}

/** Amount-page path with trailing slash, e.g. `/cambio-franco-euro/4000-franchi-in-euro/`. */
export function buildExchangeAmountPath(locale: ExchangeLocale, amount: number): string {
  return `${buildExchangeHubPath(locale)}${exchangeAmountSlug(locale, amount)}/`;
}

/**
 * Nearest curated amount page for an arbitrary CHF value (used by cross-links
 * from calculator results / salary-hub scenarios). Returns the hub when the
 * value is non-finite or absurd.
 */
export function buildNearestExchangeAmountPath(locale: ExchangeLocale, chf: number): string {
  if (!Number.isFinite(chf) || chf <= 0) return buildExchangeHubPath(locale);
  let best = EXCHANGE_AMOUNTS[0];
  for (const a of EXCHANGE_AMOUNTS) {
    if (Math.abs(a - chf) < Math.abs(best - chf)) best = a;
  }
  return buildExchangeAmountPath(locale, best);
}

// ── Route matching (services/router.ts) ─────────────────────────────────────
// Client-side twin of build-plugins/exchangeRateSsgData.ts's isExchangeSsgPath
// (which is node-context and boolean-only). Router needs the parsed locale
// too, mirroring build-plugins/salaryStatsData.ts's isXPath/parseXPath shape.

export interface ExchangeSsgPath {
  locale: ExchangeLocale;
  kind: 'hub' | 'amount';
  amount?: number;
  path: string;
}

/** Enumerate every canonical path (locale × hub + curated amounts). */
export function listAllExchangeSsgPaths(): ExchangeSsgPath[] {
  const out: ExchangeSsgPath[] = [];
  for (const locale of EXCHANGE_LOCALES) {
    out.push({ locale, kind: 'hub', path: buildExchangeHubPath(locale) });
    for (const amount of EXCHANGE_AMOUNTS) {
      out.push({ locale, kind: 'amount', amount, path: buildExchangeAmountPath(locale, amount) });
    }
  }
  return out;
}

const EXCHANGE_SSG_PATH_INDEX: ReadonlyMap<string, ExchangeSsgPath> = new Map(
  listAllExchangeSsgPaths().map((p) => [p.path, p]),
);

function normalizeExchangePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

export function isExchangeSsgPath(urlPath: string): boolean {
  return EXCHANGE_SSG_PATH_INDEX.has(normalizeExchangePath(urlPath));
}

export function parseExchangeSsgPath(urlPath: string): ExchangeSsgPath | null {
  return EXCHANGE_SSG_PATH_INDEX.get(normalizeExchangePath(urlPath)) ?? null;
}
