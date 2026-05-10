/**
 * Canton URL slug helpers.
 *
 * Source of truth: data/canton-url-slugs.json
 *
 * Provides locale-aware URL slug lookup + reverse parse for the 26 Swiss
 * cantons + the CH-wide aggregator key (`_AGGREGATE_`). Use this module
 * everywhere a crawler/build-plugin needs to emit a canton-scoped URL.
 *
 * Conventions:
 *  - Italian (it) keeps Italian-native names (zurigo, ginevra, san-gallo).
 *  - en/de/fr use ASCII anglicized forms (zurich, geneva, graubunden).
 *  - All slugs are lowercase, hyphen-separated, ASCII-only.
 *
 * Public API:
 *   loadCantonUrlSlugs() -> object
 *   getCantonUrlSlug(cantonCode, locale) -> string | null
 *   parseCantonUrlSlug(slug, locale) -> '_AGGREGATE_' | cantonCode | null
 *   getAggregatorUrlSlug(locale) -> string
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve repo-relative data path: scripts/lib/ -> ../../data/canton-url-slugs.json
const DATA_PATH = resolve(__dirname, '..', '..', 'data', 'canton-url-slugs.json');

const SUPPORTED_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/** Cached parsed JSON + reverse lookup tables. Lazy-initialised on first call. */
let _cache = null;

function assertLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new Error(
      `[canton-url-slugs] Unsupported locale "${locale}". Expected one of: ${SUPPORTED_LOCALES.join(', ')}.`,
    );
  }
}

function buildCache() {
  const raw = readFileSync(DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || !parsed.cantons || !parsed.aggregate) {
    throw new Error('[canton-url-slugs] Invalid JSON shape: missing "cantons" or "aggregate" key.');
  }

  // Build reverse lookup: locale -> Map<slug, cantonCode | '_AGGREGATE_'>
  const reverse = {};
  for (const locale of SUPPORTED_LOCALES) {
    const map = new Map();
    for (const [code, slugs] of Object.entries(parsed.cantons)) {
      const slug = slugs?.[locale];
      if (typeof slug === 'string' && slug.length > 0) {
        map.set(slug, code);
      }
    }
    const aggSlug = parsed.aggregate?.[locale];
    if (typeof aggSlug === 'string' && aggSlug.length > 0) {
      map.set(aggSlug, '_AGGREGATE_');
    }
    reverse[locale] = map;
  }

  return { data: parsed, reverse };
}

function ensureCache() {
  if (_cache === null) {
    _cache = buildCache();
  }
  return _cache;
}

/**
 * Sync read of the canton URL slug JSON. Returns the parsed object (cached).
 * @returns {{ _comment: string, _lastUpdated: string, cantons: Record<string, Record<'it'|'en'|'de'|'fr', string>>, aggregate: Record<'it'|'en'|'de'|'fr', string> }}
 */
export function loadCantonUrlSlugs() {
  return ensureCache().data;
}

/**
 * Resolve a canton code + locale to its URL slug.
 * @param {string} cantonCode - 2-letter canton code (case-insensitive) or '_AGGREGATE_'.
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {string|null} slug, or null if unknown canton.
 */
export function getCantonUrlSlug(cantonCode, locale) {
  assertLocale(locale);
  const code = String(cantonCode || '').toUpperCase().trim();
  if (!code) return null;
  const { data } = ensureCache();
  if (code === '_AGGREGATE_') {
    return data.aggregate[locale] ?? null;
  }
  const entry = data.cantons[code];
  if (!entry) return null;
  return entry[locale] ?? null;
}

/**
 * Reverse-resolve a URL slug back to its canton code (or '_AGGREGATE_').
 * @param {string} slug - lowercased URL segment.
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {string|null} canton code, '_AGGREGATE_', or null if not found.
 */
export function parseCantonUrlSlug(slug, locale) {
  assertLocale(locale);
  const normalised = String(slug || '').toLowerCase().trim();
  if (!normalised) return null;
  const { reverse } = ensureCache();
  return reverse[locale].get(normalised) ?? null;
}

/**
 * Slug for the CH-wide aggregator page in the given locale.
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {string}
 */
export function getAggregatorUrlSlug(locale) {
  assertLocale(locale);
  const { data } = ensureCache();
  return data.aggregate[locale];
}

export const CANTON_URL_SLUG_LOCALES = SUPPORTED_LOCALES;
