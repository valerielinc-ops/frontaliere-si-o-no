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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Canton scope ─────────────────────────────────────────────
// MVP scope is Ticino. The pipeline is canton-keyed so adding VS/GR/GE later is
// data-only (a new source + a new entry here), no structural change.
export const EVENTS_CANTON = 'TI';

// ── Source registry ──────────────────────────────────────────
// One entry per crawler. `key` is the slice filename + stable-id prefix.
export const EVENT_SOURCES = {
  'tio-agenda': {
    key: 'tio-agenda',
    label: 'Tio.ch Agenda',
    homepage: 'https://www.tio.ch/agenda',
    canton: 'TI',
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

/** Localized slug of the two digest landing pages, per locale. */
export const EVENTS_DIGEST_SLUGS = {
  weekend: { it: 'questo-weekend', en: 'this-weekend', de: 'dieses-wochenende', fr: 'ce-week-end' },
  week: { it: 'questa-settimana', en: 'this-week', de: 'diese-woche', fr: 'cette-semaine' },
};

/** Canonical path of a per-comune events page in `locale` (trailing slash). */
export function eventsComunePath(locale, comune) {
  return `${EVENTS_BASE_PATH[locale]}/${slugifyComune(comune)}/`;
}

/** Canonical path of a digest landing page (`kind` = 'weekend' | 'week') in `locale`. */
export function eventsDigestPath(locale, kind) {
  return `${EVENTS_BASE_PATH[locale]}/${EVENTS_DIGEST_SLUGS[kind][locale]}/`;
}

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
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '') || (a.title || '').localeCompare(b.title || ''));
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
