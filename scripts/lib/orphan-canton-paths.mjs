/**
 * Canton-aware locale path builder for GSC orphan slugs.
 *
 * Pre-fix: `scripts/sync-gsc-orphans.mjs` defaulted every orphan's localised
 * fallback paths to Ticino — `/cerca-lavoro-ticino/${slug}/`, etc. That broke
 * jobs whose canonical canton is non-TI: e.g. RhB Chur (canton GR) slugs got
 * registered as `/en/find-jobs-ticino/...`, so the only soft-landing emitted
 * was at the wrong canton. Google's actual indexed URL
 * (`/en/find-jobs-graubunden/.../`) had no static page to land on and 404'd.
 *
 * This module infers the real canton from the orphan's GSC-reported path,
 * falling back to a slug-suffix-vs-municipality lookup, then builds the four
 * locale paths from `canton-url-slugs.mjs`. If nothing resolves confidently
 * (city not found / ambiguous across cantons), callers get the legacy
 * all-Ticino fallback so behaviour stays backward-compatible for slugs the
 * heuristic can't classify.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCantonUrlSlug,
  parseCantonUrlSlug,
} from './canton-url-slugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUNICIPALITIES_PATH = path.resolve(__dirname, '..', '..', 'data', 'canton-municipalities.json');

export const LOCALES = ['it', 'en', 'de', 'fr'];

// `/{prefix}-{cantonSlug}/{slug}` — locale-aware "job board" segment prefix.
// Mirrors build-plugins/weeklyEmployersChCantonPages.ts:JOB_BOARD_PREFIX.
const JOB_BOARD_PREFIX = Object.freeze({
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-im',
  fr: 'trouver-emploi',
});

const LOCALE_URL_PREFIX = Object.freeze({
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
});

// Alternate prefix tokens we may see on inbound GSC paths — keep in sync with
// the regexes in scripts/ingest-gsc-job-orphans.mjs:JOB_PATH_PATTERNS.
const INBOUND_PREFIX_ALTERNATES = '(?:cerca-lavoro|find-jobs|find-job|job-search|jobs-im|jobsuche|stellenangebote|recherche-emploi|trouver-emploi|emplois)';

const INBOUND_PATH_RE = new RegExp(
  `^(?:/(?:en|de|fr))?/${INBOUND_PREFIX_ALTERNATES}-([a-z-]+)/[^/]+/?$`,
);

// 6-char hex disambiguator tail appended by the slug regen step (see
// `appendDisambiguatorTail` in regenerate-slugs-helpers.mjs). Strip it before
// looking up the city — the city name is what comes immediately before it.
const DISAMBIGUATOR_TAIL_RE = /-[a-f0-9]{6}$/;

let _cityCantonIndex = null;

function normalizeCityToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build (and cache) a `Map<normalizedCity, Set<cantonCode>>` from the BFS
 * canton-municipalities snapshot. Multi-canton hits (e.g. "Buchs" lives in
 * several cantons) keep all members in the Set so callers can decide whether
 * an ambiguous match should be treated as "no confident match".
 */
export function buildCityCantonIndex() {
  if (_cityCantonIndex) return _cityCantonIndex;
  let data = { cantons: {} };
  try {
    data = JSON.parse(fs.readFileSync(MUNICIPALITIES_PATH, 'utf8')) || { cantons: {} };
  } catch {
    // Fall through — empty index means inference falls back to TI later.
  }
  const index = new Map();
  for (const [code, entry] of Object.entries(data.cantons || {})) {
    const cities = [
      ...(Array.isArray(entry?.municipalities) ? entry.municipalities : []),
      ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    ];
    for (const city of cities) {
      const norm = normalizeCityToken(city);
      if (!norm) continue;
      if (!index.has(norm)) index.set(norm, new Set());
      index.get(norm).add(code);
    }
  }
  _cityCantonIndex = index;
  return index;
}

/** Reset the cached index. Used by tests; not part of the public CLI flow. */
export function _resetCityCantonIndex() {
  _cityCantonIndex = null;
}

/**
 * Walk the GSC-reported path and reverse-resolve its canton segment to a code.
 * Returns null when the path doesn't match the locale-job-board shape or the
 * canton segment isn't a known slug in any of the 4 locales.
 */
export function inferCantonFromPath(orphanPath) {
  if (!orphanPath) return null;
  const m = String(orphanPath).match(INBOUND_PATH_RE);
  if (!m) return null;
  const cantonSlug = m[1];
  for (const loc of LOCALES) {
    let code;
    try {
      code = parseCantonUrlSlug(cantonSlug, loc);
    } catch {
      continue;
    }
    if (code && code !== '_AGGREGATE_') return code;
  }
  return null;
}

/**
 * Find the canton implied by the slug's city suffix. Tries the trailing 1-3
 * tokens (cities can be hyphenated: "san-gallo", "la-chaux-de-fonds") and
 * returns a single canton code only when the match is unambiguous. Multi-
 * canton hits return null so the caller falls back gracefully — picking one
 * arbitrarily would re-create the original "wrong canton" bug.
 */
export function inferCantonFromSlug(slug, cityIndex = buildCityCantonIndex()) {
  if (!slug) return null;
  const base = String(slug).replace(DISAMBIGUATOR_TAIL_RE, '');
  const tokens = base.split('-').filter(Boolean);
  if (tokens.length === 0) return null;
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    const candidate = tokens.slice(-n).join('-');
    const cantons = cityIndex.get(candidate);
    if (cantons && cantons.size === 1) {
      return [...cantons][0];
    }
  }
  return null;
}

/**
 * Build the four locale paths for a slug under a specific canton. Returns
 * null if the canton has no URL slug for any of the 4 locales — callers
 * should fall back to `buildDefaultTiPaths` in that case.
 */
export function buildLocaleJobPaths(slug, cantonCode) {
  if (!slug || !cantonCode) return null;
  const paths = {};
  for (const loc of LOCALES) {
    const cantonSlug = getCantonUrlSlug(cantonCode, loc);
    if (!cantonSlug) return null;
    const prefix = LOCALE_URL_PREFIX[loc];
    paths[loc] = `${prefix}/${JOB_BOARD_PREFIX[loc]}-${cantonSlug}/${slug}`;
  }
  return paths;
}

/** Legacy all-Ticino fallback. Preserves the pre-fix shape for slugs whose
 *  canton can't be inferred — backward-compatible safety net. */
export function buildDefaultTiPaths(slug) {
  return {
    it: `/cerca-lavoro-ticino/${slug}`,
    en: `/en/find-jobs-ticino/${slug}`,
    de: `/de/jobs-im-tessin/${slug}`,
    fr: `/fr/trouver-emploi-tessin/${slug}`,
  };
}

/**
 * One-stop builder for an orphan: prefer the GSC-reported path's canton,
 * then the slug-suffix-derived canton, then fall back to the legacy Ticino
 * paths. Always returns a 4-locale path map.
 *
 * Optional `pathHints` lets callers pass already-known canton-prefixed paths
 * (e.g. a tracking entry from `all-known-job-slugs.json`) so the resolver
 * can read the canton off any of them too.
 */
export function buildOrphanLocalePaths(orphan, options = {}) {
  const cityIndex = options.cityIndex || buildCityCantonIndex();
  const slug = orphan?.slug;
  if (!slug) return null;

  const canton =
    inferCantonFromPath(orphan?.path) ||
    inferCantonFromHints(options.pathHints) ||
    inferCantonFromSlug(slug, cityIndex);

  if (canton) {
    const paths = buildLocaleJobPaths(slug, canton);
    if (paths) return paths;
  }
  return buildDefaultTiPaths(slug);
}

function inferCantonFromHints(hints) {
  if (!hints) return null;
  const candidates = Array.isArray(hints) ? hints : Object.values(hints);
  for (const candidate of candidates) {
    const c = inferCantonFromPath(candidate);
    if (c) return c;
  }
  return null;
}
