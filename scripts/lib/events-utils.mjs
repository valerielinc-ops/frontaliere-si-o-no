/**
 * Channel-agnostic helpers shared by the events crawlers, the events dataset
 * assembler, the `eventsSeoPagesPlugin` build plugin and the vitest suite.
 *
 * The events feature mirrors the jobs pipeline: each crawler writes a per-source
 * slice (`data/events/by-source/<key>.json`), the assembler merges the slices
 * into `data/events.json` (deduped by stable id, stale events pruned), and the
 * build plugin emits per-comune + canton-hub static pages from the assembled
 * dataset.
 *
 * Everything here is pure data/string logic (no Facebook / Reddit / channel
 * specifics and no DOM), so it is importable from both `.mjs` runtime scripts
 * and `.ts` build plugins (project rule AGENTS.md §6: a helper/constant
 * duplicated literally across ≥2 files MUST live in ONE shared module).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import CANTON_URL_SLUGS from '../../data/canton-url-slugs.json' with { type: 'json' };
import { MUNICIPALITIES } from '../../data/municipalities.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Canton scope ─────────────────────────────────────────────
// Legacy single-canton constant, kept for the TI-only call sites that predate
// nationwide sourcing (FB poster, weekend-digest article generator). New code
// should be canton-agnostic (see `resolveComuneNationwide` / `eventsBasePathForCanton`
// below) — the pipeline is canton-keyed, so nationwide sources are data-only
// (a new EVENT_SOURCES entry with `canton: null`), no structural change.
export const EVENTS_CANTON = 'TI';

// ── Source registry ──────────────────────────────────────────
// One entry per crawler. `key` is the slice filename + stable-id prefix.
// `canton: null` means the source is nationwide (event canton resolved
// per-event from the matched comune, see `resolveComuneNationwide`).
export const EVENT_SOURCES = {
  'tio-agenda': {
    key: 'tio-agenda',
    label: 'Tio.ch Agenda',
    homepage: 'https://www.tio.ch/agenda',
    canton: 'TI',
  },
  guidle: {
    key: 'guidle',
    label: 'Guidle',
    homepage: 'https://www.guidle.com',
    canton: null,
  },
  myswitzerland: {
    key: 'myswitzerland',
    label: 'MySwitzerland',
    homepage: 'https://www.myswitzerland.com',
    canton: null,
  },
};

// ── Localized URL path config (single source of truth, §6) ───
// The events SSG pages live under a LOCALIZED base segment per locale (en/de/fr
// translate "events/ticino"). The build plugin AND any script that deep-links to
// these pages (the FB poster, the weekend-digest article generator) MUST use
// these exact values — duplicating them is what made the digest article emit
// /en/eventi/ticino/… (404) instead of /en/events/ticino/… (PR #3088 review).
export const EVENTS_BASE_PATH = {
  it: '/eventi/ticino',
  en: '/en/events/ticino',
  de: '/de/veranstaltungen/tessin',
  fr: '/fr/evenements/tessin',
};

// ── Localized base path, any canton ────────────────────────────
// Generalization of EVENTS_BASE_PATH for nationwide rollout (F3). Reuses
// `data/canton-url-slugs.json` — the SAME slug table the job board uses (§6,
// no second canton→slug dictionary) — so a canton's events URL segment matches
// its job-board URL segment. Verified byte-identical to the literal
// EVENTS_BASE_PATH above for TI (ticino/ticino/tessin/tessin) — see
// tests/events-utils.test.ts.
const EVENTS_LOCALIZED_SEGMENT = {
  it: (slug) => `/eventi/${slug}`,
  en: (slug) => `/en/events/${slug}`,
  de: (slug) => `/de/veranstaltungen/${slug}`,
  fr: (slug) => `/fr/evenements/${slug}`,
};

/**
 * Localized events base path for any of the 26 cantons (half-cantons AI/AR and
 * BL/BS collapse onto their URL group, same as the job board — see
 * `services/cantonList.ts` / `services/router.ts` resolveCantonGroup). Falls
 * back to the literal `EVENTS_BASE_PATH` (TI) for an unknown/blank canton so
 * callers that don't resolve a canton degrade to the original MVP behavior.
 */
export function eventsBasePathForCanton(canton) {
  const code = String(canton || '').toUpperCase().trim();
  if (!code) return EVENTS_BASE_PATH;
  const groups = CANTON_URL_SLUGS.cantonGroups ?? {};
  let urlKey = code;
  for (const [groupKey, def] of Object.entries(groups)) {
    if ((def?.members ?? []).map((m) => String(m).toUpperCase()).includes(code)) {
      urlKey = groupKey;
      break;
    }
  }
  const record = CANTON_URL_SLUGS.cantons?.[urlKey];
  if (!record) return EVENTS_BASE_PATH;
  const out = {};
  for (const locale of Object.keys(EVENTS_LOCALIZED_SEGMENT)) {
    out[locale] = EVENTS_LOCALIZED_SEGMENT[locale](record[locale] || record.it);
  }
  return out;
}

/** Localized slug of the two digest landing pages, per locale. */
export const EVENTS_DIGEST_SLUGS = {
  weekend: { it: 'questo-weekend', en: 'this-weekend', de: 'dieses-wochenende', fr: 'ce-week-end' },
  week: { it: 'questa-settimana', en: 'this-week', de: 'diese-woche', fr: 'cette-semaine' },
};

// ── Ticino agenda regions → representative comune ────────────
// tio.ch tags every event with a tourism region adjective ("Luganese",
// "Locarnese", …). When no exact comune name is found in the venue/title we
// attribute the event to the region's main comune (medium confidence) so the
// comune page still surfaces genuinely local events. Keep keys diacritic-free
// and lowercase — matched via `normalizeText`.
export const REGION_TO_COMUNE = {
  luganese: 'Lugano',
  locarnese: 'Locarno',
  mendrisiotto: 'Mendrisio',
  bellinzonese: 'Bellinzona',
  'tre valli': 'Biasca',
  'tre-valli': 'Biasca',
  vallemaggia: 'Maggia',
  'valle maggia': 'Maggia',
  leventina: 'Faido',
  bleniese: 'Blenio',
  blenio: 'Blenio',
  riviera: 'Biasca',
  malcantone: 'Caslano',
};

// ── Text normalization ───────────────────────────────────────
/** Lowercase + strip diacritics (NFD) for robust, accent-insensitive matching. */
export function normalizeText(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Canonical URL slug for a comune name (diacritic-free, hyphenated, ascii). */
export function slugifyComune(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable, URL-safe slug for a single event detail page: `<title>-<YYYY-MM-DD>`
 * (title truncated at a word boundary). Deterministic from title+startDate so
 * the detail-page URL is stable across crawl runs. Collisions (same title+date
 * in the same comune) are disambiguated by the caller (the SSG emit loop).
 */
export function slugifyEvent(event) {
  const titlePart = truncateSlugAtWordBoundary(slugifyComune(event?.title || ''), 60).replace(/-+$/, '');
  const datePart = String(event?.startDate || '').slice(0, 10);
  const base = [titlePart, datePart].filter(Boolean).join('-');
  return base || `evento-${slugifyComune(event?.id || 'senza-data')}`;
}

// ── Comuni loader ────────────────────────────────────────────
let _comuniCache = null;

/**
 * Load the canonical list of comuni for a canton from
 * `data/canton-municipalities.json`. Returns an array of canonical names.
 */
export function loadCantonComuni(canton = EVENTS_CANTON) {
  if (_comuniCache && _comuniCache.canton === canton) return _comuniCache.list;
  const file = path.join(REPO_ROOT, 'data', 'canton-municipalities.json');
  let list = [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    list = raw?.cantons?.[canton]?.municipalities ?? [];
  } catch {
    list = [];
  }
  _comuniCache = { canton, list };
  return list;
}

/**
 * Resolve an event to a canonical comune name.
 *
 * Strategy (highest confidence first):
 *   1. exact — a comune name token appears as a word in `venue`/`title`
 *      (e.g. "Teatro Sociale Bellinzona" → Bellinzona).
 *   2. region — the tio.ch region adjective maps to a main comune
 *      (e.g. region "Luganese" → Lugano).
 *   3. null — no confident attribution (event shown on the canton hub only).
 *
 * Returns `{ comune, method }` where method is 'exact' | 'region' | null.
 */
export function resolveComune({ venue, title, region }, comuni = loadCantonComuni()) {
  const haystack = `${normalizeText(venue)} ${normalizeText(title)}`;
  // Longest names first so "Riva San Vitale" wins over "Riviera".
  const ranked = [...comuni].sort((a, b) => b.length - a.length);
  for (const name of ranked) {
    const norm = normalizeText(name);
    if (!norm) continue;
    // Word-boundary match on the normalized comune token.
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(norm)}([^a-z0-9]|$)`);
    if (re.test(haystack)) return { comune: name, method: 'exact' };
  }
  const regionKey = normalizeText(region);
  if (regionKey && REGION_TO_COMUNE[regionKey]) {
    const mapped = REGION_TO_COMUNE[regionKey];
    if (comuni.includes(mapped)) return { comune: mapped, method: 'region' };
  }
  return { comune: null, method: null };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Nationwide comuni (all 26 cantons) ────────────────────────
let _allComuniCache = null;

/**
 * Flatten `data/canton-municipalities.json` into `{ name, canton }` records
 * across every canton (2110 comuni). Used by `resolveComuneNationwide` for
 * sources that are not canton-scoped (guidle, myswitzerland). Cached once —
 * the file is static data, not a live crawl input.
 */
export function loadAllComuni() {
  if (_allComuniCache) return _allComuniCache;
  const file = path.join(REPO_ROOT, 'data', 'canton-municipalities.json');
  let out = [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    for (const [canton, def] of Object.entries(raw?.cantons ?? {})) {
      for (const name of def?.municipalities ?? []) out.push({ name, canton });
    }
  } catch {
    out = [];
  }
  _allComuniCache = out;
  return out;
}

/**
 * Nationwide generalization of `resolveComune` for sources without a fixed
 * canton (guidle, myswitzerland — see EVENT_SOURCES `canton: null`).
 *
 * Strategy (highest confidence first):
 *   1. `cantonHint` given (e.g. resolved from a source's `address.addressLocality`
 *      postal-code lookup, or an upstream canton facet) — scope the exact-match
 *      search to that canton's comuni first (identical to `resolveComune`).
 *   2. Nationwide exact — same word-boundary token match as `resolveComune`,
 *      but ranked across all 2110 comuni (longest name first, so multi-word
 *      comuni like "Riva San Vitale" win over a shorter substring elsewhere).
 *      Duplicate comune names across cantons (e.g. two cantons both have a
 *      "Buchs") resolve to whichever is matched first in the length-ranked
 *      scan — ambiguous but rare, and never worse than no attribution.
 *   3. TI region fallback — only applies when `cantonHint === 'TI'` (or no
 *      hint) and the region string is a known tio.ch-style adjective; region
 *      vocabulary is TI-specific, not meaningful for other cantons.
 *   4. null — no confident attribution.
 *
 * Returns `{ comune, canton, method }`, method one of
 * 'exact' | 'exact-nationwide' | 'region' | null.
 */
export function resolveComuneNationwide({ venue, title, region }, cantonHint) {
  const hint = String(cantonHint || '').toUpperCase().trim();
  if (hint) {
    const scoped = resolveComune({ venue, title, region }, loadCantonComuni(hint));
    if (scoped.comune) return { ...scoped, canton: hint };
  }

  const haystack = `${normalizeText(venue)} ${normalizeText(title)}`;
  const ranked = [...loadAllComuni()].sort((a, b) => b.name.length - a.name.length);
  for (const { name, canton } of ranked) {
    const norm = normalizeText(name);
    if (!norm) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(norm)}([^a-z0-9]|$)`);
    if (re.test(haystack)) return { comune: name, canton, method: 'exact-nationwide' };
  }

  if (!hint || hint === 'TI') {
    const regionKey = normalizeText(region);
    if (regionKey && REGION_TO_COMUNE[regionKey]) {
      const mapped = REGION_TO_COMUNE[regionKey];
      if (loadCantonComuni('TI').includes(mapped)) return { comune: mapped, canton: 'TI', method: 'region' };
    }
  }
  return { comune: null, canton: null, method: null };
}

// ── Italian frontier comuni geo-matching ──────────────────────
/** Great-circle distance in km between two lat/lng points (haversine). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Italian border comuni (data/municipalities.ts, 518 comuni across 11
 * provinces) do not have their own crawled event source — guidle and
 * myswitzerland only index Swiss events. Instead, a CH event near the border
 * IS relevant to a frontaliere living there ("eventi vicino a te"), so events
 * with known geo-coordinates are geo-linked to nearby Italian frontier comuni
 * at assemble time.
 *
 * Returns up to 5 comune names within `maxKm` (nearest first), or `[]` when
 * the event has no geo or nothing is within range.
 */
export function resolveItalianFrontierComuni(geo, { maxKm = 15 } = {}) {
  const lat = geo?.lat;
  const lng = geo?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return [];
  return MUNICIPALITIES.map((m) => ({ name: m.name, km: haversineKm(lat, lng, m.lat, m.lng) }))
    .filter((m) => m.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, 5)
    .map((m) => m.name);
}

// ── Event image mirroring ──────────────────────────────────────
// Crawled event images MUST NOT be hotlinked (the source site must never see
// a request originating from a real visitor's browser) — download once at
// crawl time, store under public/images/events/, and let the existing CDN
// offload pipeline (scripts/offload-generated-images-cdn.mjs,
// services/cdnImageBase.ts) serve them from our own domain, same as
// brand/provider logos. Idempotent: skips the network fetch when the file
// already exists, so re-running a crawler doesn't re-download unchanged images.
const EVENT_IMAGE_DIR = path.join(REPO_ROOT, 'public', 'images', 'events');
const EVENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 4MB guard against a mis-served asset
const EVENT_IMAGE_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * Download an event's source image once and store it locally under
 * `public/images/events/<sourceKey>-<rawId>.<ext>`. Returns the site-relative
 * path (e.g. `/images/events/guidle-Acv6rYJ.jpg`) on success, or `null` on any
 * failure (missing URL, network error, oversized/non-image response) — callers
 * MUST treat a null return as "no image" (never fall back to the original
 * remote URL, that would defeat the no-hotlink requirement).
 */
export async function mirrorEventImage(sourceUrl, stableId) {
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;
  const safeId = String(stableId || '').replace(/[^a-zA-Z0-9:_-]/g, '').replace(/:/g, '-');
  if (!safeId) return null;

  mkdirSync(EVENT_IMAGE_DIR, { recursive: true });
  const existingMatch = ['jpg', 'jpeg', 'png', 'webp']
    .map((ext) => path.join(EVENT_IMAGE_DIR, `${safeId}.${ext}`))
    .find((p) => existsSync(p));
  if (existingMatch) return `/images/events/${path.basename(existingMatch)}`;

  try {
    const res = await fetch(sourceUrl, { headers: { 'User-Agent': EVENT_IMAGE_USER_AGENT } });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > EVENT_IMAGE_MAX_BYTES) return null;
    const ext = extFromContentType(contentType);
    const fileName = `${safeId}.${ext}`;
    writeFileSync(path.join(EVENT_IMAGE_DIR, fileName), buf);
    return `/images/events/${fileName}`;
  } catch {
    return null;
  }
}

// ── Stable identity ──────────────────────────────────────────
/** Stable event id: `<sourceKey>:<rawId>`. Used for dedup across crawl runs. */
export function eventStableId(sourceKey, rawId) {
  return `${sourceKey}:${String(rawId).trim()}`;
}

// ── Date helpers ─────────────────────────────────────────────
/** Convert "YYYYMMDD" → "YYYY-MM-DD". Returns '' on malformed input. */
export function isoFromCompactDate(compact) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(compact ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** "YYYY-MM-DD" string for a Date, in UTC (stable across runners). */
export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// ── Dataset I/O ──────────────────────────────────────────────
export const EVENTS_DATASET_PATH = path.join(REPO_ROOT, 'data', 'events.json');
export const EVENTS_SLICE_DIR = path.join(REPO_ROOT, 'data', 'events', 'by-source');

/**
 * Read the assembled events dataset. Returns `{ schemaVersion, generatedAt,
 * events: [] }` on missing/malformed file — never throws.
 */
export function loadEventsDataset(file = EVENTS_DATASET_PATH) {
  try {
    if (!existsSync(file)) return { schemaVersion: 1, generatedAt: null, events: [] };
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (!raw || !Array.isArray(raw.events)) return { schemaVersion: 1, generatedAt: null, events: [] };
    return raw;
  } catch {
    return { schemaVersion: 1, generatedAt: null, events: [] };
  }
}

/**
 * Filter to upcoming events (startDate >= `todayIso`) and sort ascending by
 * date then title. `todayIso` defaults to undefined — callers pass the build's
 * day stamp so the result is deterministic.
 */
export function upcomingEvents(events, todayIso) {
  const today = todayIso || isoDay(new Date());
  return [...events]
    .filter((e) => e && typeof e.startDate === 'string' && (e.endDate || e.startDate) >= today)
    .sort(
      (a, b) =>
        (a.startDate || '').localeCompare(b.startDate || '') ||
        (a.title || '').localeCompare(b.title || '') ||
        (a.id || '').localeCompare(b.id || ''),
    );
}

/** Group events by their resolved comune (events without a comune are dropped). */
export function groupByComune(events) {
  const map = new Map();
  for (const e of events) {
    if (!e?.comune) continue;
    if (!map.has(e.comune)) map.set(e.comune, []);
    map.get(e.comune).push(e);
  }
  return map;
}

// ── Date windows (shared by the SSG digest plugin, the FB digest poster and the
//    weekly digest article generator — single source of truth, no drift, §6) ──

/**
 * True when an event's [startDate, endDate] span overlaps the inclusive
 * [startIso, endIso] window. Multi-day events count for every day they touch.
 */
export function overlapsWindow(event, startIso, endIso) {
  const s = event?.startDate;
  if (typeof s !== 'string') return false;
  const end = event.endDate || event.startDate;
  return s <= endIso && end >= startIso;
}

/**
 * The current/upcoming weekend as a SINGLE contiguous [start, end] window,
 * clipped to `todayIso` (never includes a past Saturday).
 * - Mon–Fri → upcoming Saturday + Sunday.
 * - Saturday → today + tomorrow (Sun).
 * - Sunday → today only (the weekend's Saturday already past).
 * Must NOT use min/max of an 8-day weekend scan (on Sat/Sun that picks up the
 * FOLLOWING Saturday → a non-contiguous span covering the whole week).
 */
export function weekendWindow(todayIso) {
  const day = todayIso || isoDay(new Date());
  const today = new Date(`${day}T00:00:00Z`);
  const dow = today.getUTCDay(); // 0=Sun … 6=Sat
  const sat =
    dow === 6
      ? today
      : dow === 0
        ? new Date(today.getTime() - 86400000)
        : new Date(today.getTime() + (6 - dow) * 86400000);
  const sun = new Date(sat.getTime() + 86400000);
  const startMs = Math.max(sat.getTime(), today.getTime()); // never include a past Saturday
  return { start: new Date(startMs).toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10) };
}

/** Inclusive [todayIso, todayIso + days) window for the "this week" digest. */
export function weekWindow(todayIso, days = 7) {
  const start = todayIso || isoDay(new Date());
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  return { start, end: end.toISOString().slice(0, 10) };
}

/** Upcoming events overlapping the current/upcoming weekend, date-sorted. */
export function weekendEvents(events, todayIso) {
  const { start, end } = weekendWindow(todayIso);
  return upcomingEvents(events, todayIso).filter((e) => overlapsWindow(e, start, end));
}
