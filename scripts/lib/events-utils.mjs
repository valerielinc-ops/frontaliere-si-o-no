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
import { freeTranslateWithRetry } from './free-translate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Canton scope ─────────────────────────────────────────────
// Legacy single-canton constant, kept for the TI-only call sites that predate
// nationwide sourcing (FB poster, weekend-digest article generator). New code
// should be canton-agnostic (see `resolveComuneNationwide` / `eventsBasePathForCanton`
// below) — the pipeline is canton-keyed, so nationwide sources are data-only
// (a new EVENT_SOURCES entry with `canton: null`), no structural change.
export const EVENTS_CANTON = 'TI';

// ── Feasibility: individual comune sites as a source (#3047 item 1) ──────
// Researched 2026-07-02 (follow-up chained on #2963 → #3044 → #3047). The
// #3044 PR body flagged two gaps: "altri cantoni" (other cantons) and
// "crawler siti comunali singoli" (individual comune sites), both blocked on
// "richiedono mappa comune→URL ufficiale (assente nei dataset)".
//
// Verdict, split by sub-item:
//   - "altri cantoni" — RESOLVED, moot. #3125 (guidle + myswitzerland below,
//     `canton: null`) already went nationwide via aggregator PLATFORMS, not
//     per-comune scraping — no comune→URL map was ever needed for this half.
//   - "crawler siti comunali singoli" — genuinely NOT feasible with existing
//     data, confirmed live:
//       * data/canton-municipalities.json (built by
//         generate-canton-municipalities.mjs from the official BFS AGV
//         Communes API, agvchapp.bfs.admin.ch/api/communes/snapshot) has
//         columns HistoricalCode/BfsCode/ValidFrom/ValidTo/Level/Parent/
//         Name/ShortName/Inscription/Radiation/Rec_Type_fr/Rec_Type_de —
//         no website/URL column (checked the live CSV response directly).
//       * data/municipalities.ts (Italian frontier comuni) has no URL field
//         either, and is a different country's comuni anyway (not a Swiss
//         events source).
//       * No data/*.json in the repo maps comune → website.
//       * Checked the two most plausible FREE external registries: Canton
//         Ticino's own comuni registry (www4.ti.ch/di/sel/comuni/elenco-comuni)
//         only offers a downloadable Excel of comuni-per-district counts, no
//         website column; ch.ch's federal portal claims ~2100 communes but
//         only via its own per-page search UI — no bulk CSV/JSON export. The
//         only way to get a comune→URL map would be scraping ~100 (TI) to
//         ~2100 (nationwide) individual undocumented pages just to bootstrap
//         a seed list for ANOTHER crawler — a new project of its own, not a
//         "build from existing data" win, AND even then each comune site
//         would need its own scraper/selectors (no shared platform like
//         guidle's), an unbounded maintenance burden for the frontier-comuni
//         audience this site already reaches well via guidle/myswitzerland.
// Not forcing a fake per-comune crawler here. Re-open only if a genuine bulk
// comune→URL dataset shows up (re-check ch.ch / opendata.swiss periodically).
//
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
  // Pilot non-TI source-canton crawler (issue #3644, F2 of #3125) — validates
  // the createAgendaCrawler factory (scripts/lib/agenda-crawler-factory.mjs)
  // on a second canton. City of Geneva's own official events listing
  // (Drupal "Views" pager, `?page=N`, no API/key) — see scripts/crawl-ge-agenda.mjs.
  'ge-agenda': {
    key: 'ge-agenda',
    label: 'Ville de Genève Agenda',
    homepage: 'https://www.geneve.ch/agenda',
    canton: 'GE',
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
  // locale-segment-ok: per-locale branch keyed by its own locale, each arm only ever emits its own segment
  en: (slug) => `/en/events/${slug}`,
  // locale-segment-ok: per-locale branch keyed by its own locale, each arm only ever emits its own segment
  de: (slug) => `/de/veranstaltungen/${slug}`,
  // locale-segment-ok: per-locale branch keyed by its own locale, each arm only ever emits its own segment
  fr: (slug) => `/fr/evenements/${slug}`,
};

// ── Swiss-wide events index hub (issue #3645, F3) ───────────────────────
// Canton-less base path for the `/eventi/` (+ locale variants) index hub that
// sits one level above every per-canton hub built from
// `EVENTS_LOCALIZED_SEGMENT`. DERIVED from the same builders (calling each
// with an empty slug and trimming the trailing slash) rather than a second
// literal copy of the "eventi"/"events"/"veranstaltungen"/"evenements"
// strings — the exact duplication bug §6 exists to prevent (issue #3088).
export const EVENTS_INDEX_PATH = Object.fromEntries(
  Object.entries(EVENTS_LOCALIZED_SEGMENT).map(([locale, segmentFor]) => [locale, segmentFor('').replace(/\/$/, '')]),
);

/**
 * Localized events base path for any of the 26 cantons (half-cantons AI/AR and
 * BL/BS collapse onto their URL group, same as the job board — see
 * `services/cantonList.ts` / `services/router.ts` resolveCantonGroup). Falls
 * back to the literal `EVENTS_BASE_PATH` (TI) for an unknown/blank canton so
 * callers that don't resolve a canton degrade to the original MVP behavior.
 */
/**
 * Resolve a real canton BFS code (or half-canton member) to the URL group key
 * used by `data/canton-url-slugs.json` (e.g. `AI`/`AR` → `APPENZELLO`,
 * `BL`/`BS` → `BASILEA`, everything else → itself unchanged). Extracted so
 * both `eventsBasePathForCanton` and `germanCantonPreposition` share one
 * canton→URL-key resolver (§6). Returns the uppercased input unchanged when
 * it is not a recognised group member.
 */
export function resolveCantonUrlKey(canton) {
  const code = String(canton || '').toUpperCase().trim();
  if (!code) return code;
  const groups = CANTON_URL_SLUGS.cantonGroups ?? {};
  for (const [groupKey, def] of Object.entries(groups)) {
    if ((def?.members ?? []).map((m) => String(m).toUpperCase()).includes(code)) {
      return groupKey;
    }
  }
  return code;
}

export function eventsBasePathForCanton(canton) {
  const code = String(canton || '').toUpperCase().trim();
  // Additive-only (issue #3739): a brand-new sentinel none of this function's
  // existing callers (FB poster, job/events crosslink, digest content) ever
  // pass — every pre-existing branch below is untouched.
  if (code === UNRESOLVED_CANTON_KEY) {
    const out = {};
    for (const locale of Object.keys(EVENTS_LOCALIZED_SEGMENT)) {
      out[locale] = EVENTS_LOCALIZED_SEGMENT[locale](UNRESOLVED_CANTON_SEGMENT[locale]);
    }
    return out;
  }
  if (!code) return EVENTS_BASE_PATH;
  const urlKey = resolveCantonUrlKey(code);
  const record = CANTON_URL_SLUGS.cantons?.[urlKey];
  if (!record) return EVENTS_BASE_PATH;
  const out = {};
  for (const locale of Object.keys(EVENTS_LOCALIZED_SEGMENT)) {
    out[locale] = EVENTS_LOCALIZED_SEGMENT[locale](record[locale] || record.it);
  }
  return out;
}

/**
 * German preposition for "<preposition> <canton display name>" prose (e.g.
 * "im Tessin", "im Aargau", "in der Waadt", "in Zürich") for any of the 26
 * cantons — used by the events SSG plugin's canton-agnostic (non-TI) copy
 * generator. Reuses the SAME `dePrefix` override table the job board URL
 * slugs use (`data/canton-url-slugs.json`, §6 — no second grammar table):
 * `jobs-im-` → "im", `jobs-in-der-` → "in der", no override → "in" (correct
 * for the majority of cantons whose German name takes no article, e.g.
 * Zürich, Bern, Genf, Basel). TI itself is NOT routed through this helper —
 * the legacy literal copy hardcodes "im Tessin" — this only serves the other
 * 23 cantons/groups.
 */
export function germanCantonPreposition(canton) {
  const urlKey = resolveCantonUrlKey(canton);
  const record = CANTON_URL_SLUGS.cantons?.[urlKey];
  if (record?.dePrefix === 'jobs-im-') return 'im';
  if (record?.dePrefix === 'jobs-in-der-') return 'in der';
  return 'in';
}

/** Localized slug of the two digest landing pages, per locale. */
export const EVENTS_DIGEST_SLUGS = {
  weekend: { it: 'questo-weekend', en: 'this-weekend', de: 'dieses-wochenende', fr: 'ce-week-end' },
  week: { it: 'questa-settimana', en: 'this-week', de: 'diese-woche', fr: 'cette-semaine' },
};

/**
 * Localized slug for the catch-all "other events" bucket page — events whose
 * comune could not be confidently resolved (`comune === null`, see
 * `resolveComune`/`resolveComuneNationwide`) still get their own internal
 * detail page here instead of falling back to a raw external link (the
 * "detail page doesn't open" bug: `groupByComune` intentionally drops
 * comune-less events, so they never got a `detailSlugs` entry before this
 * bucket existed). Never a substitute for a real comune — an honest label,
 * not a fabricated one.
 */
export const OTHER_EVENTS_SEGMENT = {
  it: 'altri-eventi',
  en: 'other-events',
  de: 'weitere-veranstaltungen',
  fr: 'autres-evenements',
};

/**
 * Sentinel `comune` value used ONLY by the build plugin's `detailSlugs`/routing
 * layer to represent the catch-all "other events" bucket (never written into
 * the dataset itself, never passed to `groupByComune` — that function's
 * contract of dropping `comune == null` events is intentional and untouched,
 * see `tests/events-pipeline.test.ts`). The plugin computes comune-less events
 * separately and keys them under this sentinel so they still resolve to an
 * internal detail page instead of falling back to the raw crawled URL. Never
 * render this raw string to a human — always map it through
 * `OTHER_EVENTS_SEGMENT` (routing) or a canton display name (copy).
 */
export const OTHER_EVENTS_COMUNE_KEY = '__other-events__';

// ── Canton-neutral bucket (issue #3739) ────────────────────────
// Sentinel canton key used ONLY by the build plugin's grouping/routing layer
// when a nationwide-source event's canton could not be resolved at all
// (`event.canton === ''`). Before this existed, every unresolved-canton event
// was silently folded into the Ticino hub via `event.canton || 'TI'` — a real
// event with an unknown location got mislabeled as a Ticino one. Never
// written into the dataset itself (crawlers leave `event.canton` blank when
// unresolved) and never rendered raw — always mapped through
// `UNRESOLVED_CANTON_SEGMENT` (routing) or a dedicated display label (copy).
// Already uppercase so every `.toUpperCase()` call in the canton-resolution
// chain is a no-op on it.
export const UNRESOLVED_CANTON_KEY = '__UNRESOLVED-CANTON__';

/** Localized URL segment for the canton-neutral bucket's hub page. */
export const UNRESOLVED_CANTON_SEGMENT = {
  it: 'altri-cantoni',
  en: 'other-cantons',
  de: 'weitere-kantone',
  fr: 'autres-cantons',
};

/**
 * Localized display copy for the canton-neutral bucket (issue #3739) — the
 * getCantonLabel()/CANTON_NAME_BY_CODE lookups every caller normally uses
 * only know the 26 real BFS codes, so they'd otherwise echo the raw
 * `UNRESOLVED_CANTON_KEY` sentinel back into rendered HTML/copy. Shared
 * between the build plugin and the FB events poster (AGENTS.md §6 — single
 * source instead of a copy-pasted literal per caller).
 */
export const UNRESOLVED_CANTON_LABEL = {
  it: 'altri cantoni',
  en: 'other cantons',
  de: 'weiteren Kantonen',
  fr: 'autres cantons',
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

  // ── Genève agenda quartiers/region fallback (issue #3644 pilot) ───────
  // geneve.ch/agenda's card listing doesn't print a quartier name inline
  // (only a sidebar facet does), so scripts/crawl-ge-agenda.mjs passes the
  // literal region hint 'Genève' for every event — the whole source is
  // scoped to the single municipality "Genève", so this always resolves.
  // The 7 real quartier names are also mapped (same 'Genève' comune, since
  // canton GE's municipality list has one "Genève" entry) for forward
  // compatibility if a future pass starts reading the quartier facet.
  geneve: 'Genève',
  champel: 'Genève',
  'eaux-vives cite': 'Genève',
  'grottes saint-gervais': 'Genève',
  'paquis secheron': 'Genève',
  'plainpalais jonction': 'Genève',
  'saint-jean charmilles': 'Genève',
  'servette petit-saconnex': 'Genève',
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan `haystack` for every entry in `ranked` (already longest-name-first)
 * whose name appears as a whole word/token. Shared by `resolveComune` and
 * `resolveComuneNationwide` so the word-boundary regex and the "which
 * candidate wins" rule can't drift between the canton-scoped and nationwide
 * matchers (AGENTS.md §6 — one construct, one place).
 *
 * Returns ALL matches, not just the winner: callers use `hits[0]` as the
 * chosen comune (existing longest-wins behavior) and `hits.length > 1` to
 * detect an ambiguous card (the venue/title text names more than one comune).
 */
function matchComuneNames(haystack, ranked, nameOf = (entry) => entry) {
  const hits = [];
  for (const entry of ranked) {
    const norm = normalizeText(nameOf(entry));
    if (!norm) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(norm)}([^a-z0-9]|$)`);
    if (re.test(haystack)) hits.push(entry);
  }
  return hits;
}

/**
 * Log an "uncertain match" warning when a card's venue/title text names more
 * than one comune (ambiguous — item 4 of issue #3036: a card that parses fine
 * but could plausibly be assigned the wrong comune). Caps the listed
 * candidates so a pathological card can't flood the log.
 */
function warnIfAmbiguousComuneMatch({ venue, title }, hits, nameOf = (entry) => entry) {
  if (hits.length <= 1) return;
  const chosen = nameOf(hits[0]);
  const others = hits.slice(1, 4).map(nameOf);
  console.warn(
    `[events] resolveComune: uncertain match — chose "${chosen}" over ${others.length} other ` +
      `candidate(s) [${others.join(', ')}] for venue="${venue || ''}" title="${title || ''}"`,
  );
}

/**
 * Resolve an event to a canonical comune name.
 *
 * Strategy (highest confidence first):
 *   1. exact — a comune name token appears as a word in `venue`/`title`
 *      (e.g. "Teatro Sociale Bellinzona" → Bellinzona). If more than one
 *      comune name matches (ambiguous card), the longest name still wins but
 *      a warning is logged so the case is observable/countable, not silent.
 *   2. region — the tio.ch region adjective maps to a main comune
 *      (e.g. region "Luganese" → Lugano). Lower confidence: the venue/title
 *      text never named a specific comune, so events genuinely local to a
 *      smaller comune in the region get attributed to the region's main
 *      comune instead. The crawler entrypoint aggregates this method's share
 *      across a run and warns when it dominates (see crawl-tio-agenda.mjs).
 *   3. null — no confident attribution (event shown on the canton hub only).
 *
 * Returns `{ comune, method }` where method is 'exact' | 'region' | null.
 */
export function resolveComune({ venue, title, region }, comuni = loadCantonComuni()) {
  const haystack = `${normalizeText(venue)} ${normalizeText(title)}`;
  // Longest names first so "Riva San Vitale" wins over "Riviera".
  const ranked = [...comuni].sort((a, b) => b.length - a.length);
  const hits = matchComuneNames(haystack, ranked);
  if (hits.length) {
    warnIfAmbiguousComuneMatch({ venue, title }, hits);
    return { comune: hits[0], method: 'exact' };
  }
  const regionKey = normalizeText(region);
  if (regionKey && REGION_TO_COMUNE[regionKey]) {
    const mapped = REGION_TO_COMUNE[regionKey];
    if (comuni.includes(mapped)) return { comune: mapped, method: 'region' };
  }
  return { comune: null, method: null };
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
 *   4. Canton-hint retention (issue #3739) — comune text-matching found
 *      nothing at all, but `cantonHint` is itself a real, recognized canton
 *      code (e.g. myswitzerland's `addressRegion`, exact for fused post-2011
 *      comuni like "Niederurnen" or non-comune toponyms like "Petersplatz"
 *      that never text-match a municipality name) — keep that known-good
 *      canton signal instead of discarding it to null.
 *   5. null — no confident attribution at all.
 *
 * Returns `{ comune, canton, method }`, method one of
 * 'exact' | 'exact-nationwide' | 'region' | 'canton-hint' | null.
 */
let _validCantonCodesCache = null;

/** True when `code` is one of the 26 real canton BFS codes in data/canton-municipalities.json. */
function isValidCantonCode(code) {
  if (!_validCantonCodesCache) {
    _validCantonCodesCache = new Set(loadAllComuni().map((entry) => entry.canton));
  }
  return _validCantonCodesCache.has(code);
}

export function resolveComuneNationwide({ venue, title, region }, cantonHint) {
  const hint = String(cantonHint || '').toUpperCase().trim();
  if (hint) {
    const scoped = resolveComune({ venue, title, region }, loadCantonComuni(hint));
    if (scoped.comune) return { ...scoped, canton: hint };
  }

  const haystack = `${normalizeText(venue)} ${normalizeText(title)}`;
  const ranked = [...loadAllComuni()].sort((a, b) => b.name.length - a.name.length);
  const hits = matchComuneNames(haystack, ranked, (entry) => entry.name);
  if (hits.length) {
    warnIfAmbiguousComuneMatch({ venue, title }, hits, (entry) => entry.name);
    const winner = hits[0];
    return { comune: winner.name, canton: winner.canton, method: 'exact-nationwide' };
  }

  if (!hint || hint === 'TI') {
    const regionKey = normalizeText(region);
    if (regionKey && REGION_TO_COMUNE[regionKey]) {
      const mapped = REGION_TO_COMUNE[regionKey];
      if (loadCantonComuni('TI').includes(mapped)) return { comune: mapped, canton: 'TI', method: 'region' };
    }
  }
  // #3739: comune text-matching failed entirely, but the caller supplied a
  // high-confidence canton signal that IS a real canton — keep it rather
  // than discarding a known-good signal (previously this fell all the way
  // through to canton: null too, so a resolvable canton with just an
  // unmatched venue string still hit the SSG plugin's `|| 'TI'` default and
  // got mislabeled as a Ticino event).
  if (hint && isValidCantonCode(hint)) {
    return { comune: null, canton: hint, method: 'canton-hint' };
  }
  return { comune: null, canton: null, method: null };
}

// ── Italian frontier comuni geo-matching ──────────────────────
// haversineKm now lives in ./haversine.mjs, a leaf with no imports. Imported
// AND re-exported, not `export ... from`: this module calls it itself, and a
// bare re-export forwards the name without binding it in local scope, so the
// internal callers would hit a ReferenceError. Import it from the leaf directly
// when you only need the distance and not this module's canton-slug dependency
// (issue #4974 item 3).
import { haversineKm } from './haversine.mjs';
export { haversineKm };

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

// Re-encode before storing: the source sites serve print-resolution originals
// (measured 2026-08-20 over the whole folder: 4'089 jpg/png averaging 936-1'226 KB,
// the largest 4.1 MB), and this crawler runs daily, so storing the bytes verbatim
// added 3'154 MB to the repo in 30 days — 46% of the entire tracked tree in a
// single month. 1600px is deliberately above what any layout requests, so the
// saving comes from the format and not from throwing away resolution: on a
// 12-file sample spanning the size distribution, most sources are already
// <=1600px wide and are not resized at all, yet the sample still comes down 87%.
const EVENT_IMAGE_MAX_WIDTH = 1600;
// Portrait sources (extreme aspect ratio) had no bound on the resulting
// height: `resize({ width })` alone only constrains the horizontal axis, so a
// very tall source stayed very tall after re-encoding. Same cap as the width
// — `fit: 'inside'` only applies whichever bound is actually the binding one
// for a given source, so ordinary landscape photos resize exactly as before.
const EVENT_IMAGE_MAX_HEIGHT = 1600;
const EVENT_IMAGE_WEBP_QUALITY = 82;
const EVENT_IMAGE_WEBP_EFFORT = 6;

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * Re-encode a downloaded event image to WebP, capped at EVENT_IMAGE_MAX_WIDTH
 * x EVENT_IMAGE_MAX_HEIGHT (whichever bound is binding for the source's
 * aspect ratio).
 * Returns `{ buf, ext }` — always something storable, never throws.
 *
 * Two deliberate fallbacks to the original bytes, both of which keep the image
 * rather than losing it:
 *   • sharp unavailable or unable to decode → store the source as-is. The job of
 *     this function is to mirror the image; an optimiser that fails must not cost
 *     the events funnel its picture. It logs, because a silent fallback here means
 *     the growth quietly resumes.
 *   • re-encode came out no smaller → keep the original. Sources that already
 *     serve an optimised WebP (ge-agenda ships 2.5-5 KB files) would otherwise be
 *     made bigger by a pointless round-trip. Same guard as
 *     scripts/backfill-blog-webp.mjs.
 */
async function encodeEventImage(buf, contentType) {
  const originalExt = extFromContentType(contentType);
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buf)
      .resize({ width: EVENT_IMAGE_MAX_WIDTH, height: EVENT_IMAGE_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: EVENT_IMAGE_WEBP_QUALITY, effort: EVENT_IMAGE_WEBP_EFFORT })
      .toBuffer();
    if (out.length >= buf.length) return { buf, ext: originalExt };
    return { buf: out, ext: 'webp' };
  } catch (err) {
    console.warn(`[events] image re-encode failed, storing original: ${err?.message || err}`);
    return { buf, ext: originalExt };
  }
}

/**
 * Download an event's source image once and store it locally under
 * `public/images/events/<sourceKey>-<rawId>.<ext>`. Returns the site-relative
 * path (e.g. `/images/events/guidle-Acv6rYJ.webp`) on success, or `null` on any
 * failure (missing URL, network error, oversized/non-image response) — callers
 * MUST treat a null return as "no image" (never fall back to the original
 * remote URL, that would defeat the no-hotlink requirement).
 *
 * The stored extension is normally `webp` — encodeEventImage re-encodes what
 * was downloaded; the source's own extension survives only when that is
 * skipped.
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
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > EVENT_IMAGE_MAX_BYTES) return null;
    const { buf, ext } = await encodeEventImage(raw, contentType);
    const fileName = `${safeId}.${ext}`;
    writeFileSync(path.join(EVENT_IMAGE_DIR, fileName), buf);
    return `/images/events/${fileName}`;
  } catch {
    return null;
  }
}

// ── Referral tracking ────────────────────────────────────────
/**
 * Outbound "official site" CTA URL with UTM referral tagging — same shape as
 * `build-plugins/jobsSeoPagesPlugin.ts`'s `referralUrl()` for job postings
 * (§6: one UTM-tagging convention, not a copy per feature), campaign renamed
 * for events. Never fabricates a URL: on a malformed `rawUrl` it is returned
 * unchanged rather than dropped, so a broken source URL never silently loses
 * its outbound link.
 */
export function eventReferralUrl(rawUrl, event) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('utm_source', 'frontaliereticino');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'events');
    u.searchParams.set('utm_content', String(event?.id || event?.sourceKey || '').trim());
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// ── Free geocoding (OpenStreetMap Nominatim, cached) ──────────
// tio-agenda cards never carry `geo`/`address` (only guidle/myswitzerland do),
// so a detail page for a tio-agenda event previously had nothing to put on a
// map. Nominatim is free (no API key) but requires a custom User-Agent and a
// polite ≤1 req/s rate — the caller (crawl-tio-agenda.mjs) is responsible for
// pacing; this module only owns the disk cache so a venue already resolved on
// a previous crawl run never re-hits the network.
const GEOCODE_CACHE_PATH = path.join(REPO_ROOT, 'data', 'events-geocode-cache.json');
const NOMINATIM_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';

/** Load the on-disk geocode cache (`{ [normalizedQuery]: {lat,lng} | null }`). */
export function loadGeocodeCache() {
  try {
    if (!existsSync(GEOCODE_CACHE_PATH)) return {};
    const raw = JSON.parse(readFileSync(GEOCODE_CACHE_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Persist the geocode cache back to disk (pretty-printed, stable diffs). */
export function saveGeocodeCache(cache) {
  writeFileSync(GEOCODE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

/**
 * Resolve a free-text location query (e.g. "Teatro Sociale, Bellinzona,
 * Ticino, Switzerland") to `{lat, lng}` via the free OpenStreetMap Nominatim
 * search API, restricted to Switzerland. Cached in `cache` (pass the object
 * returned by `loadGeocodeCache`, mutated in place — caller saves it once
 * after a run, not per-call). A cached `null` (no match found previously) is
 * honored without a repeat network call. Never fabricates coordinates: any
 * failure or no-result returns/`caches` `null`.
 */
export async function geocodeVenue(query, cache, fetchImpl = fetch) {
  const key = normalizeText(query);
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'ch' });
    const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null; // transient failure — don't cache, retry next run
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    const lat = hit ? Number.parseFloat(hit.lat) : NaN;
    const lng = hit ? Number.parseFloat(hit.lon) : NaN;
    const geo = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    cache[key] = geo;
    return geo;
  } catch {
    return null; // network/timeout — don't cache, retry next run
  }
}

// ── Title translation cache ────────────────────────────────────
// tio-agenda cards carry no `titleByLocale` at all (unlike guidle/
// myswitzerland — see file header), so every en/de/fr locale falls back to
// the raw Italian title. Translating is cheap (free-translate.mjs cascade)
// but the crawler rewrites its whole slice from scratch every run (no
// historical merge — see crawl-tio-agenda.mjs main()), so without a disk
// cache the SAME recurring event title would be re-translated every single
// day forever. Cached here by normalized Italian title so only genuinely new
// titles cost a network call.
const TRANSLATION_CACHE_PATH = path.join(REPO_ROOT, 'data', 'events-translation-cache.json');

/** Load the on-disk title translation cache (`{ [normalizedItTitle]: {en?,de?,fr?} }`). */
export function loadEventTitleTranslationCache() {
  try {
    if (!existsSync(TRANSLATION_CACHE_PATH)) return {};
    const raw = JSON.parse(readFileSync(TRANSLATION_CACHE_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Persist the title translation cache back to disk (pretty-printed, stable diffs). */
export function saveEventTitleTranslationCache(cache) {
  writeFileSync(TRANSLATION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

// ── Cross-locale fallback translation (issue #3741) ──────────────────────
// tio-agenda (crawl-tio-agenda.mjs `enrichEventsWithTranslations`) already
// runs the free-translate.mjs cascade for its own locale-less IT-only cards.
// The two nationwide sources (guidle, myswitzerland) DO ship real per-locale
// `titleByLocale`/`descriptionByLocale` text, but the organizer very often
// leaves it duplicated verbatim across locales instead of translating it —
// verified live: 699/854 myswitzerland events and 89/97 guidle events carry
// identical text in every present locale (vs 0/133 for tio-agenda). A locale
// slot counts as "untranslated" when it is missing OR its normalized text
// collides with another present locale's normalized text; those slots get
// machine-translated from the first present, non-colliding locale (in
// `locales` priority order), or from the first present locale if ALL of them
// collide. Shared here (not copy-pasted into both crawlers, AGENTS.md §6) and
// reuses the SAME on-disk cache as `loadEventTitleTranslationCache` — a
// compound key (`fieldType::sourceLocale::normalizedSourceText`) keeps new
// entries collision-free against tio-agenda's own bare-title keys.
const LOCALE_FALLBACK_DELAY_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which locales in `byLocale` (a `titleByLocale`/`descriptionByLocale`-shaped
 * map) need a machine translation: missing, or textually identical (after
 * accent/case/whitespace normalization) to another present locale. Pure — no
 * network, no mutation. Exported for direct unit testing.
 */
export function localesNeedingTranslation(byLocale, locales = ['it', 'en', 'de', 'fr']) {
  const present = locales.filter((l) => typeof byLocale?.[l] === 'string' && byLocale[l].trim());
  const normalized = new Map();
  const counts = new Map();
  for (const l of present) {
    const n = normalizeText(byLocale[l]).replace(/\s+/g, ' ');
    normalized.set(l, n);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const needing = [];
  for (const l of locales) {
    if (!present.includes(l)) {
      needing.push(l);
    } else if ((counts.get(normalized.get(l)) || 0) > 1) {
      needing.push(l); // duplicate of another present locale — treat as untranslated
    }
  }
  return needing;
}

/**
 * Fill in missing/duplicate locales of ONE `titleByLocale`/
 * `descriptionByLocale` map via the free translation cascade, memoized on
 * disk in `cache` (caller loads/saves once per run, same convention as
 * `loadEventTitleTranslationCache`). Returns a NEW map — never mutates
 * `byLocale` — or the SAME reference when nothing needs translating.
 */
async function fillLocaleGaps(byLocale, cache, { fieldType, locales, delayMs, translateFn }) {
  const needing = localesNeedingTranslation(byLocale, locales);
  if (needing.length === 0) return byLocale;

  const present = locales.filter((l) => typeof byLocale?.[l] === 'string' && byLocale[l].trim());
  if (present.length === 0) return byLocale;
  const sourceLocale = present.find((l) => !needing.includes(l)) || present[0];
  const sourceText = byLocale[sourceLocale];
  const normalizedSource = normalizeText(sourceText).replace(/\s+/g, ' ');

  const updated = { ...byLocale };
  for (const target of needing) {
    if (target === sourceLocale) continue;
    const cacheKey = `${fieldType}::${sourceLocale}::${normalizedSource}`;
    const entry = cache[cacheKey] || {};
    let translated = entry[target];
    if (!translated) {
      translated = await translateFn({ text: sourceText, sourceLang: sourceLocale, targetLang: target, fieldType, maxRetries: 1 });
      if (translated) {
        cache[cacheKey] = { ...entry, [target]: translated };
        if (translateFn === freeTranslateWithRetry) await sleep(delayMs);
      }
    }
    if (translated) updated[target] = translated;
  }
  return updated;
}

/**
 * Enrich a batch of SiteEvent-shaped records — fills gaps in both
 * `titleByLocale` and `descriptionByLocale` for every event, memoized via
 * `cache` (load once, mutate, save once — see
 * `loadEventTitleTranslationCache`/`saveEventTitleTranslationCache`). Returns
 * a NEW array; events are shallow-copied, never mutated in place. Used by
 * `crawl-myswitzerland-events.mjs` and `crawl-guidle-events.mjs`; `translateFn`
 * is injectable so tests never hit the network.
 *
 * `deadline` (epoch ms, opt-in) caps this stage's wall clock. Past it the
 * remaining events are passed through untranslated — they keep the
 * source-locale text they already carry, and their gaps are refilled on a
 * later run from the persisted cache. Unbounded, this is the single longest
 * thing either nationwide crawler does: one sequential network round trip per
 * missing locale per field, so a few hundred events cost thousands of
 * requests, and neither crawler's RUN_BUDGET_MS covered it — that cap stops
 * the VISIT loop and nothing after it.
 *
 * That gap is what cancelled crawl-events every day from 2026-07-07 on. The
 * budgeted visit loop stopped on time, this stage then ate the remainder of
 * timeout-minutes, and the job was killed before saveCursor() and
 * mergeEventsIntoSlice() ever ran — so the myswitzerland checkpoint froze at
 * index 1331/21314, every run redid the same 320 records and threw them away,
 * and the "Commit dataset" step was never reached at all. It is the same
 * failure mode as tio-agenda's 2026-07-03 backlog pass (run 28683305065),
 * one stage further down, which is why raising timeout-minutes to 60 then did
 * not prevent it: an unbounded stage expands to whatever budget it is given.
 */
export async function enrichEventsWithLocaleFallbackTranslations(events, cache, options = {}) {
  const {
    locales = ['it', 'en', 'de', 'fr'],
    delayMs = LOCALE_FALLBACK_DELAY_MS,
    translateFn = freeTranslateWithRetry,
    deadline = null,
  } = options;
  const out = [];
  let skipped = 0;
  for (const event of events) {
    const next = { ...event };
    if (deadline !== null && Date.now() >= deadline) {
      // Shallow-copied like every other element, so the "new array, never
      // mutated in place" contract holds on the timed-out tail too.
      out.push(next);
      skipped += 1;
      continue;
    }
    if (event.titleByLocale) {
      next.titleByLocale = await fillLocaleGaps(event.titleByLocale, cache, { fieldType: 'title', locales, delayMs, translateFn });
    }
    if (event.descriptionByLocale) {
      next.descriptionByLocale = await fillLocaleGaps(event.descriptionByLocale, cache, {
        fieldType: 'description',
        locales,
        delayMs,
        translateFn,
      });
    }
    out.push(next);
  }
  if (skipped) {
    console.log(
      `[events] locale-fallback translation: budget reached — ${skipped}/${events.length} event(s) passed through ` +
        `untranslated (source-locale text kept), gaps retried next run`,
    );
  }
  return out;
}

// ── Stable identity ──────────────────────────────────────────
/** Stable event id: `<sourceKey>:<rawId>`. Used for dedup across crawl runs. */
export function eventStableId(sourceKey, rawId) {
  return `${sourceKey}:${String(rawId).trim()}`;
}

// ── Price parsing ────────────────────────────────────────────
// Shared by every crawler that scrapes a free-text price field (guidle's
// price accordion, tio-agenda's "Prezzo:" label) — one regex pair, not a
// copy per crawler (AGENTS.md §6: literal duplicate regex across ≥2 files
// must live in one shared module).
const PRICE_FREE_RE = /\b(gratis|gratuit[oe]?|free|kostenlos|eintritt frei|entr[ée]e libre|ingresso libero)\b/i;
const PRICE_AMOUNT_RE = /(\d+(?:[.,]\d{1,2})?)/g;

/**
 * Parse a free-text price snippet (e.g. "CHF 10.00 pro Person", "Ingresso 20
 * franchi, Bambini gratis", "Eintritt frei") into `{amount, currency, isFree}`.
 * Takes the CHEAPEST number found when several are present. Falls back to a
 * free-keyword match when no number is present, and to `amount: null` (price
 * info exists but isn't machine-parseable, e.g. "su richiesta" / "on
 * request") otherwise. Returns `undefined` for empty/missing input — callers
 * treat that as "no price signal at all", never as "free".
 */
export function parsePriceText(rawText) {
  const t = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim() : '';
  if (!t) return undefined;
  const numbers = [];
  PRICE_AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = PRICE_AMOUNT_RE.exec(t))) {
    const n = Number.parseFloat(m[1].replace(',', '.'));
    if (Number.isFinite(n)) numbers.push(n);
  }
  if (numbers.length) {
    const amount = Math.min(...numbers);
    return { amount, currency: 'CHF', isFree: amount === 0 };
  }
  if (PRICE_FREE_RE.test(t)) return { amount: 0, currency: 'CHF', isFree: true };
  return { amount: null, currency: 'CHF', isFree: false };
}

/**
 * Whether a parsed `{amount, currency, isFree}` price carries a confident
 * enough signal to publish as schema.org `offers` — `isFree: true` or a real
 * parsed `amount`. Excludes the `amount: null` ambiguous bucket (price
 * mentioned but not machine-parseable, e.g. "su richiesta"): asserting
 * `price:"0"` there would fabricate "free" for a plausibly-paid event.
 */
export function hasConfidentPrice(price) {
  return Boolean(price) && (price.isFree === true || typeof price.amount === 'number');
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

/**
 * Grace-window default for `recentlyEndedEvents` — how many days after an
 * event ends it still gets an (orphaned, noindex) detail bridge page instead
 * of vanishing outright on the next rebuild.
 */
export const EVENT_PAST_GRACE_DAYS = 14;

/**
 * Events that ended within the last `graceDays` days (default
 * `EVENT_PAST_GRACE_DAYS`), sorted descending (most recently ended first).
 * Used only to emit orphaned `noindex,follow` bridge pages for a short
 * window — NOT part of `upcomingEvents`'s indexable/sitemap set.
 */
export function recentlyEndedEvents(events, todayIso, graceDays = EVENT_PAST_GRACE_DAYS) {
  const today = todayIso || isoDay(new Date());
  const cutoffDate = new Date(`${today}T00:00:00.000Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - graceDays);
  const cutoff = isoDay(cutoffDate);
  return [...events]
    .filter((e) => {
      if (!e || typeof e.startDate !== 'string') return false;
      const end = e.endDate || e.startDate;
      return end < today && end >= cutoff;
    })
    .sort(
      (a, b) =>
        (b.endDate || b.startDate || '').localeCompare(a.endDate || a.startDate || '') ||
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
