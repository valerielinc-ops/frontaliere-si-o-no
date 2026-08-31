import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import { TARGET_CANTONS, SWISS_CANTONS, isTargetCanton } from './crawler-location-config.mjs';

// ─── Text normalization ────────────────────────────────────────────────────

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSwissTargetLocationText(text = '') {
  return normalizeToken(text);
}

// MUNICIPALITY_DATA is a static JSON import (see top of file) — this makes
// the module bundleable for BOTH Node execution (standalone `scripts/*.mjs`
// crawlers) AND the browser client build. `jobPostingSchema.ts` (which
// re-exports through here) is shared with `services/seoService.ts` for
// runtime SPA JSON-LD injection, so this file is reachable from Rollup's
// CLIENT bundle graph, not just Node-side build plugins. The previous
// `fs.readFileSync(dirname(fileURLToPath(...)))` approach needed Node's
// `fs`/`path`/`url` builtins, which Rollup cannot provide when bundling for
// the browser target — surfaced as a closeBundle-time Rollup failure
// 2026-07-26 ("'dirname' is not exported by '__vite-browser-external'"),
// masked for ~2 days by an unrelated build-race bug that failed earlier in
// the pipeline (see docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames).
// Same JSON-import convention already used by build-plugins/fiscalMunicipalityData.ts,
// build-plugins/healthFacilitiesData.ts, and scripts/lib/events-utils.mjs.

// ─── Ambiguous municipality tokens ─────────────────────────────────────────
// A few real Swiss municipalities have single-word names that, after accent
// stripping + lower-casing, collide with common words that routinely appear in
// ordinary job-posting prose (especially worldwide retail listings). Matching
// such a bare word as a standalone Swiss location token produces false
// positives — e.g. "Retail Sales" → Sâles (FR), "concise job description" →
// Concise (VD), "tennis court" / "in short, …" → Court (BE) — letting foreign
// jobs leak into the Switzerland-only board (Swatch Group US "Keyholder" leak,
// 2026-06-17: 50+ US/AU/UK jobs stamped canton=TI because "sales" matched
// Sâles).
//
// These tokens are excluded from the city-token sets below, so the bare word
// alone no longer classifies a job as Swiss. A genuine job in one of these
// villages is still recognised via OTHER signals (canton name "Fribourg" /
// "Vaud" / "Bern", "Switzerland", a 4-digit postal code, the "(FR)" canton
// code, or a multi-word locality). The villages are tiny and well outside the
// Ticino-frontaliere target, so the trade-off is safe.
//
// Criterion: single-word BFS token that is also a common EN/FR/DE/IT word
// frequently present in job descriptions. Regenerate candidates by
// cross-checking the BFS tokens against a dictionary; confirm each by hand
// before adding (do NOT add distinctive town names like Locarno/Sion/Bern, and
// note `Fully` (VS) is asserted by tests/target-swiss-locations.test.ts).
export const AMBIGUOUS_LOCATION_WORD_TOKENS = new Set([
  'sales',   // Sâles (FR)
  'concise', // Concise (VD)
  'court',   // Court (BE)
]);

// BFS disambiguates same-name municipalities across cantons with a trailing
// "(XX)" canton-code suffix (e.g. "Villeneuve (VD)" — a homonym exists
// elsewhere). normalizeToken() strips the parens but keeps the letters, so
// only the two-word disambiguated form ("villeneuve vd") is ever registered —
// a location string carrying just the bare city name ("Villeneuve", no canton
// suffix) silently fails findSwissCityInText/isKnownSwissCity. ~150 BFS
// entries share this "(XX)"-suffix pattern; most (Roche, Berg, Stein, Au, Mex,
// Muri, Wil, Grub, ...) collide with common EN/FR/DE/IT words or well-known
// Swiss company names (Roche) and would reopen the exact false-positive class
// AMBIGUOUS_LOCATION_WORD_TOKENS was built to close (Swatch Group "Sâles"
// leak) — so they are NOT blanket-registered. Only hand-vetted, low-collision
// bare forms go here, one at a time, same discipline as
// AMBIGUOUS_LOCATION_WORD_TOKENS above.
const DISAMBIGUATED_BARE_CITY_ALIASES = new Set([
  'villeneuve', // Villeneuve (VD) — distinctive proper noun, negligible collision risk
]);

/**
 * Get all city tokens (municipalities + aliases) for a canton.
 * Cached per canton code for performance.
 */
const _cantonCityTokensCache = new Map();

function getCantonCityTokens(cantonCode) {
  if (_cantonCityTokensCache.has(cantonCode)) return _cantonCityTokensCache.get(cantonCode);

  const entry = MUNICIPALITY_DATA.cantons?.[cantonCode];
  const municipalities = entry?.municipalities || [];
  const aliases = entry?.aliases || [];
  const all = [...new Set([...municipalities, ...aliases])];
  const tokens = new Set();
  for (const city of all) {
    const token = normalizeToken(city);
    if (!token || AMBIGUOUS_LOCATION_WORD_TOKENS.has(token)) continue;
    tokens.add(token);

    const disambiguated = city.match(/^(.+?)\s*\([a-z]{2}\)$/i);
    if (disambiguated) {
      const bareToken = normalizeToken(disambiguated[1]);
      if (bareToken && DISAMBIGUATED_BARE_CITY_ALIASES.has(bareToken)) tokens.add(bareToken);
    }
  }

  const result = [...tokens];
  _cantonCityTokensCache.set(cantonCode, result);
  return result;
}

// Normalized form of every raw BFS municipality/alias that belongs to canton
// `cantonCode`; a "<City> (XX)" suffix is stripped when present. These tokens
// are keyed by that canton alone — NOT folded into the global sets above.
// Registering "küsnacht" globally would
// reopen the cross-canton collision class DISAMBIGUATED_BARE_CITY_ALIASES
// exists to avoid (Roche/Berg/Stein/Au/... colliding across cantons or with
// common words in free text). But once a caller already knows the job's
// canton (`job.canton`/`region`, e.g. `sanitizeLocalityForRegion`), there is
// no ambiguity left to resolve: "Küsnacht" inside canton ZH can only mean
// Küsnacht (ZH). Used by the `cantonHint` param of isKnownSwissCity/
// isKnownSwissMunicipality below — see #6147.
const _cantonScopedBareTokensCache = new Map();

function getCantonScopedBareTokens(cantonCode) {
  if (_cantonScopedBareTokensCache.has(cantonCode)) return _cantonScopedBareTokensCache.get(cantonCode);

  const entry = MUNICIPALITY_DATA.cantons?.[cantonCode];
  const municipalities = entry?.municipalities || [];
  const aliases = entry?.aliases || [];
  const all = [...new Set([...municipalities, ...aliases])];
  // Track which distinct BFS entries produce each bare token before
  // committing anything to the returned Set. Two DIFFERENT municipalities
  // in the SAME canton could in principle share a bare name (BFS
  // disambiguates "<City> (XX)" against homonyms elsewhere in the country,
  // not against siblings in the same canton) — a plain `tokens.add()` would
  // silently collapse that onto "exists" with no way to tell which comune a
  // caller meant. No such collision exists in the current BFS snapshot
  // (verified one-shot across all 26 cantons, #6621), but if one is ever
  // introduced by a future data refresh, exclude the ambiguous token rather
  // than let it resolve to an arbitrary one of the two — same discipline as
  // AMBIGUOUS_LOCATION_WORD_TOKENS above. Regression-guarded by
  // tests/swiss-municipality-whitelist.test.ts.
  const sourcesByToken = new Map();
  for (const city of all) {
    const disambiguated = city.match(/^(.+?)\s*\([a-z]{2}\)$/i);
    const bareToken = normalizeToken(disambiguated?.[1] || city);
    // A raw municipality that is ambiguous in prose is authoritative here:
    // the caller already supplied the canton and therefore disambiguated it.
    if (!bareToken) continue;
    if (!sourcesByToken.has(bareToken)) sourcesByToken.set(bareToken, new Set());
    sourcesByToken.get(bareToken).add(city);
  }

  const tokens = new Set();
  for (const [bareToken, sources] of sourcesByToken) {
    if (sources.size > 1) continue; // ambiguous within this canton — no safe single match
    tokens.add(bareToken);
  }

  _cantonScopedBareTokensCache.set(cantonCode, tokens);
  return tokens;
}

// ─── Backward-compatible exports (used by existing tests) ──────────────────

export const TICINO_MUNICIPALITIES = MUNICIPALITY_DATA.cantons?.TI?.municipalities || [];
export const GRIGIONI_MUNICIPALITIES = MUNICIPALITY_DATA.cantons?.GR?.municipalities || [];
export const TICINO_CITIES = [...new Set([...TICINO_MUNICIPALITIES, ...(MUNICIPALITY_DATA.cantons?.TI?.aliases || [])])];
export const GRIGIONI_CITIES = [...new Set([...GRIGIONI_MUNICIPALITIES, ...(MUNICIPALITY_DATA.cantons?.GR?.aliases || [])])];

// ─── Static tokens per canton (regions, sub-regions, demonyms) ─────────────
// These are NOT city names — they're geographic/cultural terms that identify a
// canton. City names come from the BFS JSON. Canton official names come from
// SWISS_CANTONS in crawler-location-config.mjs.

const CANTON_STATIC_TOKENS = {
  TI: [
    'cantone ticino', 'canton ticino', 'canton tessin',
    'mendrisiotto', 'sopraceneri', 'sottoceneri',
    'leventina', 'vallemaggia', 'gambarogno', 'verzasca',
    'svizzera italiana',
  ],
  GR: [
    'engadina', 'engadin', 'mesolcina', 'calanca',
    'grigioni italiano', 'valposchiavo', 'bassa mesolcina',
  ],
  VS: [
    'haut-valais', 'bas-valais', 'oberwallis',
    'chablais valaisan', 'val d herens', 'val d anniviers',
    'saastal', 'lotschental', 'simplon', 'val de bagnes',
  ],
};

export const TICINO_STATIC_TOKENS = [
  ...(SWISS_CANTONS.TI?.names || []),
  ...(CANTON_STATIC_TOKENS.TI || []),
];

export const GRIGIONI_STATIC_TOKENS = [
  ...(SWISS_CANTONS.GR?.names || []),
  ...(CANTON_STATIC_TOKENS.GR || []),
];

// ─── Border proximity keywords (Italian border towns near TI) ──────────────

export const BORDER_PROXIMITY_KEYWORDS = [
  'como',
  'varese',
  'lecco',
  'novara',
  'domodossola',
  'saronno',
  'gallarate',
  'busto arsizio',
  'provincia di como',
  'provincia di varese',
];

// Border proximity keywords per canton (French border for VS)
const BORDER_PROXIMITY_BY_CANTON = {
  TI: BORDER_PROXIMITY_KEYWORDS,
  VS: [
    'haute-savoie', 'evian', 'thonon', 'saint-julien',
    'pays du leman', 'chablais francais',
  ],
};

// ─── Token matching ────────────────────────────────────────────────────────

function hasToken(tokens = [], lower = '') {
  return tokens.some((token) => {
    // Multi-word tokens (e.g. "canton ticino", "svizzera italiana") — substring match
    // is safe because the multi-word phrase is already specific enough.
    if (token.includes(' ')) return lower.includes(token);
    // Single-word tokens — ALWAYS use word boundary to prevent false positives
    // like "wallis" matching inside "wallisellen" or "bern" inside "bernina".
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
}

// ─── Canton code patterns for text matching ────────────────────────────────
// 2-letter canton codes that are safe to match as word boundaries.
// Some codes are too common as words (e.g., "BE" = English word) — only
// match those in specific contexts like "(BE)" or "3000 BE".
const SAFE_WORD_BOUNDARY_CODES = new Set(['TI', 'GR', 'VS', 'GE', 'AG', 'SG', 'TG', 'SH', 'GL', 'AI', 'AR', 'JU', 'NW', 'OW', 'UR', 'SZ', 'ZG']);

// ─── Generic canton relevance check ────────────────────────────────────────

/**
 * Check if text is relevant to a specific canton. Works for ANY of the 26
 * Swiss cantons. Uses: SWISS_CANTONS names, BFS municipalities, manual
 * aliases, static tokens, canton code patterns, and border proximity.
 */
export function isCantonRelevant(text = '', cantonCode = '', { includeBorderProximity = true } = {}) {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return false;

  const code = cantonCode.toUpperCase();

  // 1. Static tokens (canton names from SWISS_CANTONS + sub-region tokens)
  const cantonNames = SWISS_CANTONS[code]?.names || [];
  const staticTokens = CANTON_STATIC_TOKENS[code] || [];
  if (hasToken([...cantonNames, ...staticTokens], lower)) return true;

  // 2. Municipality + alias tokens from BFS JSON
  const cityTokens = getCantonCityTokens(code);
  if (cityTokens.length > 0 && hasToken(cityTokens, lower)) return true;

  // 3. Canton code patterns: "(TI)", "CH TI", "6900 TI"
  const codeLower = code.toLowerCase();
  if (new RegExp(`\\(${codeLower}\\)`, 'i').test(lower)) return true;
  if (new RegExp(`\\bch ${codeLower}\\b`, 'i').test(lower)) return true;
  if (new RegExp(`\\d{4}\\s+${codeLower}\\b`, 'i').test(lower)) return true;

  // 4. Bare word-boundary code match (only for unambiguous codes)
  if (SAFE_WORD_BOUNDARY_CODES.has(code)) {
    if (new RegExp(`\\b${codeLower}\\b`).test(lower)) return true;
  }

  // 5. Border proximity keywords (only for cantons that have them).
  // These are FOREIGN towns near the border (Como, Varese, Evian, …) — useful
  // to surface cross-border-relevant jobs, but they must NOT count as "this text
  // names a Swiss location". Callers gating foreign-job rejection pass
  // includeBorderProximity:false so that e.g. "Como, Italy" is not read as Swiss.
  if (includeBorderProximity) {
    const borderKeywords = BORDER_PROXIMITY_BY_CANTON[code];
    if (borderKeywords?.some((keyword) => lower.includes(keyword))) return true;
  }

  return false;
}

// ─── Backward-compatible wrapper functions ─────────────────────────────────

export function isTicinoRelevant(text = '') {
  return isCantonRelevant(text, 'TI');
}

export function isGrigioniRelevant(text = '') {
  return isCantonRelevant(text, 'GR');
}

// ─── Canton inference ──────────────────────────────────────────────────────

// An explicit trailing "<City> XX" canton-code suffix (the standard Swiss
// address convention, e.g. "Bern BE", "Brügg BE") is the single most
// unambiguous signal a location string can carry — the author literally
// wrote the canton abbreviation. It must outrank EVERY other signal,
// including another canton's curated `names` alias list: SWISS_CANTONS.AG's
// names includes the town "brugg" (a real, notable AG town), which — after
// accent-stripping — collides with "Brügg", a distinct BE town. Without a
// dedicated first pass, "Brügg BE" checked AG (array order precedes BE) via
// its names list before ever reaching BE's own suffix signal, silently
// mis-routing a Bern job to Aargau. This only affects multi-canton
// inference; single-canton isCantonRelevant() callers are unchanged.
function hasExplicitCantonSuffix(text = '', code = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const lastToken = trimmed.split(/\s+/).pop();
  return lastToken === code.toUpperCase();
}

// A canton NAME/CODE match (isCantonRelevant steps 1/3/4) is a curated,
// author-relevant signal — but (see hasExplicitCantonSuffix above) it can
// itself collide with another canton's trailing-code suffix, so it ranks
// below that suffix check, not above it. The BFS municipality/alias TOKEN
// match (isCantonRelevant step 2) is the fuzziest tier and stays last.
function hasStrongCantonSignal(text = '', code = '') {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return false;
  const upperCode = code.toUpperCase();
  const cantonNames = SWISS_CANTONS[upperCode]?.names || [];
  const staticTokens = CANTON_STATIC_TOKENS[upperCode] || [];
  if (hasToken([...cantonNames, ...staticTokens], lower)) return true;
  const codeLower = upperCode.toLowerCase();
  if (new RegExp(`\\(${codeLower}\\)`, 'i').test(lower)) return true;
  if (new RegExp(`\\bch ${codeLower}\\b`, 'i').test(lower)) return true;
  if (new RegExp(`\\d{4}\\s+${codeLower}\\b`, 'i').test(lower)) return true;
  return false;
}

/**
 * Infer canton from text, checking only TARGET_CANTONS.
 * Returns 2-letter code or ''.
 */
export function inferSwissTargetCanton(text = '') {
  // Pass 0: explicit trailing canton-code suffix — the strongest possible
  // signal, checked across all target cantons before any name/city match.
  for (const code of TARGET_CANTONS) {
    if (hasExplicitCantonSuffix(text, code)) return code;
  }
  // Pass 1: curated name/code signal, across all target cantons — wins
  // regardless of TARGET_CANTONS array order.
  for (const code of TARGET_CANTONS) {
    if (hasStrongCantonSignal(text, code)) return code;
  }
  // Pass 2: fall back to fuzzy city-name matching.
  for (const code of TARGET_CANTONS) {
    if (isCantonRelevant(text, code)) return code;
  }
  return '';
}

/**
 * Infer canton from text, checking ALL 26 Swiss cantons (not just target).
 * Checks target cantons first (most common in dataset), then all others.
 */
export function inferAnyCanton(text = '') {
  // Pass 0: explicit trailing canton-code suffix, across ALL 26 cantons —
  // wins regardless of which canton's name/city list would otherwise match.
  for (const code of Object.keys(SWISS_CANTONS)) {
    if (hasExplicitCantonSuffix(text, code)) return code;
  }

  // Pass 1: curated name/code signal, across ALL 26 cantons.
  for (const code of Object.keys(SWISS_CANTONS)) {
    if (hasStrongCantonSignal(text, code)) return code;
  }

  // Pass 2: fuzzy city-name matching, target cantons first (fast path for
  // common cases), then all others.
  const target = inferSwissTargetCanton(text);
  if (target) return target;

  for (const code of Object.keys(SWISS_CANTONS)) {
    if (TARGET_CANTONS.includes(code)) continue; // already checked
    if (isCantonRelevant(text, code)) return code;
  }
  return '';
}

export function normalizeCantonCode(raw = '') {
  const lower = normalizeSwissTargetLocationText(raw);
  if (!lower) return '';
  const upper = lower.toUpperCase();
  if (SWISS_CANTONS[upper]) return upper;
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    if (canton.names.some((name) => name === lower || lower === name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
      return code;
    }
  }
  return '';
}

// ─── Target location check ────────────────────────────────────────────────

export function isTargetSwissLocation(text = '', { includeGrigioni = true, includeBorderProximity = true } = {}) {
  for (const code of TARGET_CANTONS) {
    if (code === 'GR' && !includeGrigioni) continue;
    if (isCantonRelevant(text, code, { includeBorderProximity })) return true;
  }
  return false;
}

// Country-level word tokens that identify Switzerland without a city/canton.
const SWISS_COUNTRY_RE = /\b(switzerland|schweiz|suisse|svizzera|swiss)\b/i;

// Authoritative "is this free-text location in Switzerland?" check, used by the
// nationwide Workday crawlers (fnz, bracco) instead of hand-rolled per-crawler
// city allowlists (which drift and miss cantons). True when the text mentions
// the country, a BFS-known Swiss municipality/alias (all 26 cantons), or any
// inferable canton.
export function isSwissLocationText(text = '') {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (SWISS_COUNTRY_RE.test(s)) return true;
  if (findSwissCityInText(s)) return true;
  return Boolean(inferAnyCanton(s));
}

// ─── Swiss municipality existence check ──────────────────────────────────
// Fast offline check: is a city name present in any of the 2,110 BFS
// municipalities or their aliases, across all 26 cantons?

const _allSwissCityTokens = (() => {
  const tokens = new Set();
  for (const code of Object.keys(SWISS_CANTONS)) {
    for (const t of getCantonCityTokens(code)) tokens.add(t);
  }
  // Also add canton names themselves (e.g. "Ticino", "Graubünden")
  for (const canton of Object.values(SWISS_CANTONS)) {
    for (const name of canton.names || []) tokens.add(normalizeToken(name));
  }
  return tokens;
})();

// Strict municipality set: only city tokens, no canton names. Used by
// crawler validators that need to reject jobs whose `addressLocality` is
// just a canton label (e.g. "Ticino") with the actual city buried in
// the description body — see Swatch Group "Forte dei Marmi" leak.
const _strictSwissCityTokens = (() => {
  const tokens = new Set();
  for (const code of Object.keys(SWISS_CANTONS)) {
    for (const t of getCantonCityTokens(code)) tokens.add(t);
  }
  return tokens;
})();

// Token set of canton-only labels (names + 2-letter codes). Used to detect
// when a `location` field is canton-level rather than city-level.
const _cantonOnlyTokens = (() => {
  const tokens = new Set();
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    tokens.add(normalizeToken(code));
    for (const name of canton.names || []) tokens.add(normalizeToken(name));
  }
  return tokens;
})();

/**
 * Check if a city name matches any known Swiss municipality (BFS data)
 * or canton name. Returns true only for exact city-level matches,
 * not substring matching — to avoid false positives.
 *
 * `cantonHint` (optional 2-letter code or canton name, e.g. `job.canton`):
 * 161 BFS municipalities exist ONLY in the disambiguated "<City> (XX)" form
 * (homonyms across cantons, e.g. "Küsnacht (ZH)"), so their bare name fails
 * this check by default even though it names a real municipality. When the
 * caller already knows the canton, retry against that canton's own bare
 * tokens — no cross-canton ambiguity left to resolve. Without a hint (or
 * with an unresolvable one), behaviour is unchanged. See #6147.
 */
export function isKnownSwissMunicipality(cityName = '', cantonHint = '') {
  const token = normalizeToken(cityName);
  if (!token || token.length < 2) return false;
  if (_allSwissCityTokens.has(token)) return true;
  const canton = normalizeCantonCode(cantonHint);
  return canton ? getCantonScopedBareTokens(canton).has(token) : false;
}

/**
 * Strict canton-scoped municipality lookup. Unlike `isKnownSwissMunicipality`,
 * a city known in another canton does not pass: this is the disambiguator for
 * source values such as `Buchs AG` (also Buchs SG) and must not turn
 * `Baden DE` into a Swiss canton marker merely because Baden exists in AG.
 */
export function isKnownSwissMunicipalityInCanton(cityName = '', cantonHint = '') {
  const token = normalizeToken(cityName);
  const canton = normalizeCantonCode(cantonHint);
  if (!token || token.length < 2 || !canton) return false;
  return getCantonCityTokens(canton).includes(token)
    || getCantonScopedBareTokens(canton).has(token);
}

/**
 * Canton memberships for an exact BFS municipality/alias. This deliberately
 * uses the raw canton-scoped snapshot, including disambiguated and otherwise
 * prose-ambiguous names, because callers use the cardinality to reject a bare
 * homonym (`Buchs`, `Reinach`) until the source supplies a canton.
 */
export function swissMunicipalityCantons(cityName = '') {
  const token = normalizeToken(String(cityName || '').replace(/\s*\([a-z]{2}\)\s*$/i, ''));
  if (!token) return [];
  return Object.keys(SWISS_CANTONS).filter((code) => getCantonScopedBareTokens(code).has(token));
}

/**
 * Strict variant: matches only known Swiss CITIES (BFS municipalities +
 * aliases). Canton names ("Ticino", "Graubünden", "Tessin") return false.
 *
 * Use this when validating crawler output: a job whose addressLocality
 * is just a canton name has no real city and likely indicates a misclassified
 * record (the actual location is buried in the description body).
 *
 * `cantonHint`: see isKnownSwissMunicipality above.
 */
export function isKnownSwissCity(cityName = '', cantonHint = '') {
  const token = normalizeToken(cityName);
  if (!token || token.length < 2) return false;
  if (_strictSwissCityTokens.has(token)) return true;
  const canton = normalizeCantonCode(cantonHint);
  return canton ? getCantonScopedBareTokens(canton).has(token) : false;
}

/**
 * True iff the input is just a canton name/code (e.g. "Ticino", "TI",
 * "Graubünden", "GR"). False for cities and anything else.
 */
export function isCantonOnlyLabel(text = '') {
  const token = normalizeToken(text);
  if (!token) return false;
  // A canton's `names` alias list (used for keyword-relevance matching, see
  // hasStrongCantonSignal) folds in representative CITY names for cantons
  // whose own name is rarely written out (e.g. BL: "Allschwil", "Reinach",
  // "Muttenz"...) to strengthen fuzzy canton detection in free text.
  // Reusing that same list for _cantonOnlyTokens would wrongly classify a
  // real, precise municipality match as a bare canton-only label — a real
  // city carries FULL location precision, the opposite of what this
  // function is meant to detect. A known city always wins.
  if (isKnownSwissCity(text)) return false;
  return _cantonOnlyTokens.has(token);
}

// Reverse map: normalized city token → canonical BFS municipality display name
// (preserves hyphens and casing, e.g. "la chaux de fonds" → "La Chaux-de-Fonds").
// `findSwissCityInText`/`normalizeToken` deliberately return the space-normalized
// token (hyphens dropped, lower-cased) — fine for presence/whitelist checks, but
// a consumer that surfaces that token as a structured-data `addressLocality`
// would emit a malformed locality for composite municipalities (e.g.
// "La Chaux De Fonds"), a Google-Jobs de-index risk. Built from municipalities
// first (authoritative display form); aliases only fill gaps.
const _canonicalCityNameByToken = (() => {
  const map = new Map();
  for (const code of Object.keys(SWISS_CANTONS)) {
    const entry = MUNICIPALITY_DATA.cantons?.[code];
    if (!entry) continue;
    for (const name of entry.municipalities || []) {
      const token = normalizeToken(name);
      if (token && !map.has(token)) map.set(token, name);
    }
    for (const name of entry.aliases || []) {
      const token = normalizeToken(name);
      if (token && !map.has(token)) map.set(token, name);
    }
  }
  return map;
})();

/**
 * Map a Swiss city token (as returned by `findSwissCityInText`, or any free
 * city string) to its canonical BFS municipality display name, preserving
 * hyphens and casing (e.g. "la chaux de fonds" → "La Chaux-de-Fonds"). Use this
 * before surfacing a matched city as an `addressLocality`/`location`. Unknown
 * tokens fall back to a hyphen-agnostic title-case of the input (best-effort —
 * dropped hyphens can't be recovered). Empty input → ''.
 */
export function canonicalSwissCityName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const token = normalizeToken(raw);
  if (token && _canonicalCityNameByToken.has(token)) {
    return _canonicalCityNameByToken.get(token);
  }
  return raw
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim();
}

/**
 * Find any known Swiss city mentioned in free-form text. Returns the first
 * matched city token (normalized) or empty string. Used as a "rescue" path
 * when addressLocality is canton-only — we look at the description body
 * for a real city before deciding to drop the record.
 *
 * @param {string} text
 * @param {{ skipTokens?: Set<string> }} [options] - tokens to ignore. A
 *   skipped token does NOT abort the scan: the search continues so that a
 *   description reading "alle Mitarbeitenden in Winterthur" still resolves to
 *   Winterthur instead of the village of Alle (JU). Callers scanning free-form
 *   description text should pass TEXT_RESCUE_AMBIGUOUS_TOKENS — or, better,
 *   just call rescueSwissCityFromText(), which does it for them.
 */
export function findSwissCityInText(text = '', { skipTokens } = {}) {
  if (!text || typeof text !== 'string') return '';
  const norm = normalizeToken(text);
  if (!norm) return '';
  // Tokenise on whitespace; bigrams + trigrams catch multi-word cities
  // like "La Chaux-de-Fonds", "Saint-Gall".
  const words = norm.split(' ').filter((w) => w.length >= 2);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const candidate = words.slice(i, i + n).join(' ');
      if (skipTokens?.has(candidate)) continue;
      if (_strictSwissCityTokens.has(candidate)) return candidate;
    }
  }
  return '';
}

// Municipality tokens that are ALSO everyday words in the languages job ads
// are written in (de/fr/it/en) or well-known company/brand names. Scanning a
// free-text description for a city name matches these constantly — "alle"
// ("all" in German) appears in almost every German ad — so a text rescue that
// accepts them manufactures a Swiss location out of thin air.
//
// Scope is deliberately narrow: this set applies ONLY to
// rescueSwissCityFromText() (free-text description scanning). It is NOT part
// of AMBIGUOUS_LOCATION_WORD_TOKENS, because an explicit `addressLocality` of
// "Rolle" or "Fully" IS a real location the author typed on purpose, and must
// keep resolving via isKnownSwissCity()/isCantonRelevant(). The bug class is
// text rescue, so the guard belongs on text rescue only.
//
// Evidence: run 31001482058 of location-quality-audit. Cross-joining the
// per-job report against data/jobs/by-crawler/ showed 1592 published jobs whose
// city had been overwritten by the description rescue; these tokens accounted
// for 1391 of them (87%). Worked example: Roche postings in Jakarta, Kyiv,
// Michigan, Mississauga and Petaling Jaya all shipped as "Alle" (JU) because
// their German description contains the word "alle". Bühler Group postings in
// Wuxi, Curitiba and Alzenau shipped as "Bühler" (AR) — the company's own name.
//
// Criterion for adding a token: a single- or multi-word BFS token that is a
// common de/fr/it/en word or a company name, CONFIRMED against audit data.
// Do not add distinctive town names (Locarno, Sion, Winterthur, ...) — those
// appearing in a description really do signal the job's location.
// Counts below are the observed bogus rewrites from that run.
export const TEXT_RESCUE_AMBIGUOUS_TOKENS = new Set([
  'alle',     // DE "all"                      — 705 bogus rewrites → Alle (JU)
  'rolle',    // DE/FR "role" / "rôle"         — 247 → Rolle (VD)
  'buhler',   // Bühler Group (company name)   —  97 → Bühler (AR)
  'premier',  // EN/FR "first"                 —  86 → Premier (VD)
  'le lieu',  // FR "the place/venue"          —  84 → Le Lieu (VD)
  'root',     // EN "root"                     —  56 → Root (LU)
  'fully',    // EN "fully"                    —  48 → Fully (VS)
  'taverne',  // DE/FR/IT "tavern"             —  30 → Taverne (TI)
  'messen',   // DE "trade fairs" / "to measure" — 20 → Messen (SO)
  'laufen',   // DE "to run"                   —  18 → Laufen (BL)
  'dorf',     // DE "village"                  —   3 → Dorf (ZH)
  'bullet',   // EN "bullet"                   —   2 → Bullet (VD)
  'lachen',   // DE "to laugh"                 —   2 → Lachen (SZ)
  'bulle',    // FR "bubble" — named as a known hazard in this file since the
              //   ≥4-char guard was added, but 5 chars, so never caught by it
  'port',     // EN/FR/DE "port"               —   1 → Port (BE)
  'lens',     // EN "lens"                     —   1 → Lens (VS)
  'wahlen',   // DE "elections"                —   1 → Wahlen (BL)
  'speicher', // DE "storage" / "memory"       —   1 → Speicher (AR)
  'riviera',  // generic geographic term       —   1 → Riviera (TI)
  // Found by re-running the audit join against the patched rescue: these were
  // the everyday words still anchoring foreign postings after the first pass.
  'meilen',   // DE "miles" — pulled Michigan/Tampa/Boston postings into Meilen (ZH)
  'gland',    // EN "gland" — pharma descriptions (Penzberg, Mannheim) → Gland (VD)
  'rossa',    // IT "red"   — Prada's Taichung postings → Rossa (GR)
]);

/**
 * Guarded combination of findSwissCityInText() + canonicalSwissCityName():
 * accepts a match only when it is ≥4 characters AND not an everyday word.
 * Some Swiss municipality names are also everyday nouns in the job's own
 * language (e.g. "Zug" = train in German, "Bulle" = bubble in French), so a
 * description that merely mentions commute logistics ("gut mit dem Zug
 * erreichbar") must not be treated as naming the job's real city.
 *
 * The ≥4-char rule alone is far too weak: it stops "Zug" but lets through
 * "Alle" (4), "Root" (4), "Rolle" (5), "Fully" (5) and "Bulle" (5) — which
 * between them accounted for ~1.4k mislocated jobs (see
 * TEXT_RESCUE_AMBIGUOUS_TOKENS). Hence the explicit token blocklist.
 *
 * Returns '' when there is no match, the match is too short, or the match is
 * an everyday word. Single source of truth for every DESCRIPTION-text rescue
 * call site — never inline the raw
 * canonicalSwissCityName(findSwissCityInText(...)) expression instead. To pull
 * a city out of a location FIELD, use swissCityFromLocationField() below.
 */
export function rescueSwissCityFromText(text = '') {
  const found = findSwissCityInText(text, { skipTokens: TEXT_RESCUE_AMBIGUOUS_TOKENS });
  if (!found || found.length < 4) return '';
  return canonicalSwissCityName(found);
}

/**
 * Extract the Swiss city named inside a LOCATION FIELD — `addressLocality`,
 * `location`, a crawler's raw location string. Companion to
 * rescueSwissCityFromText, and the reason the two are separate functions:
 *
 *   - a description is prose the author never intended as an address, so a
 *     municipality name appearing in it is usually an everyday word →
 *     TEXT_RESCUE_AMBIGUOUS_TOKENS applies, and "Ihre Rolle im Team" must not
 *     resolve to Rolle (VD);
 *   - a location field is a place the author typed on purpose, so "Rolle" there
 *     IS Rolle (VD) → no blocklist, and no ≥4-char rule either.
 *
 * Handles the decoration crawlers wrap around a city name: "Baden, Aargau",
 * "Luzern / hybrid", "2540 Grenchen Phone", "Visp-Eyholz". Returns '' when the
 * field names no known Swiss municipality.
 *
 * Exists so neither behaviour is expressed by inlining
 * canonicalSwissCityName(findSwissCityInText(...)) at a call site, where the
 * choice of blocklist-or-not becomes invisible and drifts.
 */
export function swissCityFromLocationField(value = '') {
  return canonicalSwissCityName(findSwissCityInText(value));
}

// ─── Liechtenstein postal-code helper ──────────────────────────────────────
// Liechtenstein (FL) shares CH-style 4-digit postcodes in the 9485-9498 range.
// Crawlers must reject these because FL is not part of CH and is out of scope
// for the canton inference / SEO landings. Used by `canton-quorum-gate.mjs`.

/**
 * True if the given postal code is in the Liechtenstein range (9485-9498).
 * Accepts string or number; returns false for anything malformed.
 *
 * @param {string|number} code
 * @returns {boolean}
 */
export function isLiechtensteinPostalCode(code) {
  if (code === null || code === undefined) return false;
  const digits = String(code).trim().match(/^\d{4}$/);
  if (!digits) return false;
  const n = Number(digits[0]);
  return n >= 9485 && n <= 9498;
}

// Re-export for convenience
export { TARGET_CANTONS, isTargetCanton } from './crawler-location-config.mjs';
