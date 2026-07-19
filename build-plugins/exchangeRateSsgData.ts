/**
 * Shared data module for the CHF/EUR exchange SSG vertical (epic #4452).
 *
 * Single source of truth for:
 *   - URL structure (hub + per-amount long-tail pages, 4 locales, trailing slash)
 *   - the curated amount set (typical frontaliere gross salaries, NOT a
 *     cartesian product — issue #4454)
 *   - the committed snapshot loader (data/exchange-rate-snapshot.json,
 *     refreshed daily by .github/workflows/update-exchange-history.yml via
 *     scripts/snapshot-exchange-history.mjs — build never hits Firestore)
 *   - the precompiled path Set used by searchConsoleCompat.ts's self-map
 *     (module-load Set → O(1) per URL inside the 150k+-path compat loop).
 *
 * Kept standalone (no plugin imports) so searchConsoleCompat.ts and the
 * salary-hub cross-linking can import it without pulling the emit logic.
 */

import fs from 'node:fs';
import np from 'node:path';

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

// ── Snapshot loader ──────────────────────────────────────────────────────────

export interface ExchangeWindowStats {
  startRate: number;
  startDate: string;
  min: number;
  max: number;
  avg: number;
  changePct: number;
}

export interface ExchangePoint {
  date: string;
  rate: number;
}

export interface ExchangeSnapshot {
  updatedAt: string;
  rateDate: string;
  currentRate: number;
  source: string;
  windows: Record<'30' | '90' | '365', ExchangeWindowStats>;
  sparkline: ExchangePoint[];
  monthly: ExchangePoint[];
}

/** Plausibility band mirrored from scripts/snapshot-exchange-history.mjs. */
function isPlausibleRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0.6 && rate <= 1.6;
}

/**
 * Load + validate the committed snapshot. Returns null when the file is
 * missing or malformed — the plugin then skips emission with a warning
 * (graceful degrade, mirrors borderWaitPagesPlugin's missing-snapshot path)
 * rather than failing the whole build.
 */
export function loadExchangeSnapshot(rootDir: string): ExchangeSnapshot | null {
  const p = np.resolve(rootDir, 'data', 'exchange-rate-snapshot.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ExchangeSnapshot;
    if (!isPlausibleRate(raw.currentRate)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.rateDate))) return null;
    if (!Array.isArray(raw.sparkline) || raw.sparkline.length < 10) return null;
    if (!Array.isArray(raw.monthly) || raw.monthly.length < 3) return null;
    for (const key of ['30', '90', '365'] as const) {
      const w = raw.windows?.[key];
      if (!w || !isPlausibleRate(w.startRate)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

// ── searchConsoleCompat self-map support ─────────────────────────────────────

/**
 * Every path this vertical emits (hub + amounts × 4 locales), WITHOUT the
 * trailing slash (searchConsoleCompat normalizes paths by stripping it).
 * Precompiled ONCE at module load — never build Sets per call inside the
 * compat loop (tests/search-console-compat.test.ts resolves 150k+ paths).
 */
const EXCHANGE_SSG_PATHS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const locale of EXCHANGE_LOCALES) {
    s.add(buildExchangeHubPath(locale).replace(/\/$/, ''));
    for (const amount of EXCHANGE_AMOUNTS) {
      s.add(buildExchangeAmountPath(locale, amount).replace(/\/$/, ''));
    }
  }
  return s;
})();

/**
 * O(1) membership check for the compat self-map. `path` must be normalized
 * (leading slash, no trailing slash) — searchConsoleCompat's normalizePath
 * output shape.
 */
export function isExchangeSsgPath(path: string): boolean {
  return EXCHANGE_SSG_PATHS.has(path);
}
