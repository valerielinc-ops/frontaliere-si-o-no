/**
 * Canton list helper — exposes the 26 Swiss canton ISO codes plus per-locale
 * display labels. Sourced from `data/canton-url-slugs.json` (single source of
 * truth used by the URL router + every SEO build plugin).
 *
 * Display labels are derived from the canonical slug by re-casing the first
 * letter of every hyphen-separated segment. This avoids forking a second
 * label table that could drift from the slug table.
 *
 * Cathedral CH-wide expansion (PRs #54-60) — used by the Job Alert form's
 * canton geo-filter selector.
 */

import CANTON_URL_SLUGS_RAW from '../data/canton-url-slugs.json';

export type CantonLocale = 'it' | 'en' | 'de' | 'fr';

interface CantonUrlSlugsShape {
  cantons: Record<string, Record<CantonLocale, string>>;
}

const RAW = CANTON_URL_SLUGS_RAW as unknown as CantonUrlSlugsShape;

/**
 * 2-letter ISO canton codes (uppercase) — sorted alphabetically for stable
 * UI ordering. Frozen at module load.
 */
export const CANTON_CODES: ReadonlyArray<string> = Object.freeze(
  Object.keys(RAW.cantons).sort(),
);

function slugToLabel(slug: string): string {
  // "appenzello-interno" → "Appenzello Interno". Lossless for accented
  // labels because we work off ASCII-anglicised slugs (intentionally,
  // since they're the documented source of truth).
  return slug
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Localised display label for a canton (e.g. `TI` + `it` → "Ticino", `TI` +
 * `de` → "Tessin"). Falls back to the canton code if the slug map is
 * missing the locale or canton.
 */
export function getCantonLabel(code: string, locale: CantonLocale): string {
  const entry = RAW.cantons[code];
  if (!entry) return code;
  const slug = entry[locale] || entry.it || code;
  return slugToLabel(slug);
}

export interface CantonOption {
  code: string;
  label: string;
}

/**
 * Locale-aware ordered list of canton options for UI rendering. Sorted by
 * the localised label so users see a familiar alphabetical order
 * (Argovia, Appenzello…) regardless of the underlying ISO code order.
 */
export function listCantonOptions(locale: CantonLocale): CantonOption[] {
  return CANTON_CODES.map((code) => ({
    code,
    label: getCantonLabel(code, locale),
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}
