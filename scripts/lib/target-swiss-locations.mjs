import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import { ALL_CANTON_CODES, TARGET_CANTONS, SWISS_CANTONS, isTargetCanton } from './crawler-location-config.mjs';

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
    // Whole words, like every other token here (#9846): a substring scan read
    // the Italian "comodo" ("convenient") as Como.
    const borderKeywords = BORDER_PROXIMITY_BY_CANTON[code];
    if (borderKeywords && hasToken(borderKeywords, lower)) return true;
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

/**
 * Explicit canton markers must be checked on the raw text: normalization
 * removes parentheses, so `Buchs (AG)` becomes `buchs ag` before the generic
 * signal pass and can otherwise be claimed by the SG homonym.
 */
function hasExplicitCantonMarker(text = '', code = '') {
  const upperCode = String(code || '').toUpperCase();
  return hasExplicitCantonSuffix(text, upperCode)
    || new RegExp(`\\(\\s*${upperCode}\\s*\\)`, 'i').test(String(text || ''));
}

// Official canton names are kept separate from the representative city
// aliases in SWISS_CANTONS.names. A free-text location often contains both
// (e.g. "Reinach, Aargau"): the explicit canton name must win even when a
// city alias from another canton is longer. Keep this small map beside the
// inference policy rather than inferring it from names[] — that array also
// intentionally contains city aliases for backward-compatible matching.
const CANTON_EXPLICIT_NAMES = {
  AG: ['aargau', 'argovie', 'argovia'],
  AI: ['appenzell innerrhoden', 'appenzell rhodes-intérieures', 'appenzello interno'],
  AR: ['appenzell ausserrhoden', 'appenzell rhodes-extérieures', 'appenzello esterno'],
  BE: ['bern', 'berne', 'berna'],
  BL: ['basel-landschaft', 'bâle-campagne', 'basilea campagna'],
  BS: ['basel-stadt', 'bâle-ville', 'basilea città'],
  FR: ['fribourg', 'freiburg', 'friborgo', 'friburgo'],
  GE: ['genève', 'geneva', 'genf', 'ginevra'],
  GL: ['glarus', 'glaris', 'glarona'],
  GR: ['graubünden', 'graubunden', 'grisons', 'grigioni', 'grischun'],
  JU: ['jura', 'giura'],
  LU: ['luzern', 'lucerne', 'lucerna'],
  NE: ['neuchâtel', 'neuchatel', 'neuenburg'],
  NW: ['nidwalden', 'nidwald', 'nidvaldo'],
  OW: ['obwalden', 'obwald', 'obvaldo'],
  SG: ['st. gallen', 'st gallen', 'saint-gall', 'san gallo', 'sankt gallen', 'st-gallen'],
  SH: ['schaffhausen', 'schaffhouse', 'sciaffusa'],
  SO: ['solothurn', 'soleure', 'soletta'],
  SZ: ['schwyz', 'svitto'],
  TG: ['thurgau', 'thurgovie', 'turgovia'],
  TI: ['ticino', 'tessin'],
  UR: ['uri'],
  VD: ['vaud', 'waadt'],
  VS: ['valais', 'wallis', 'vallese'],
  ZG: ['zug', 'zoug', 'zugo'],
  ZH: ['zürich', 'zurich', 'zuerich', 'zurigo'],
};

// A canton NAME/CODE match (isCantonRelevant steps 1/3/4) is a curated,
// author-relevant signal — but (see hasExplicitCantonSuffix above) it can
// itself collide with another canton’s trailing-code suffix, so it ranks
// below that suffix check, not above it. The BFS municipality/alias TOKEN
// match (isCantonRelevant step 2) is the fuzziest tier and stays last.
function tokenMatchSpecificity(tokens = [], lower = '') {
  let best = 0;
  for (const token of tokens) {
    const normalized = normalizeSwissTargetLocationText(token);
    if (!normalized) continue;
    if (normalized.includes(' ')) {
      if (lower.includes(normalized)) best = Math.max(best, normalized.length);
      continue;
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
      best = Math.max(best, normalized.length);
    }
  }
  return best;
}

/**
 * Return a comparable strength for the curated canton signals. Full names
 * outrank shorter aliases (`appenzell ausserrhoden` > `appenzell`), while
 * contextual code forms remain stronger than any prose token.
 */
function strongCantonSignalScore(text = '', code = '') {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return 0;
  const upperCode = code.toUpperCase();
  const cantonNames = SWISS_CANTONS[upperCode]?.names || [];
  const staticTokens = CANTON_STATIC_TOKENS[upperCode] || [];
  const codeLower = upperCode.toLowerCase();
  if (new RegExp(`\\bch ${codeLower}\\b`, 'i').test(lower)) return 1_000;
  if (new RegExp(`\\d{4}\\s+${codeLower}\\b`, 'i').test(lower)) return 1_000;
  const explicitNameScore = tokenMatchSpecificity([
    ...(CANTON_EXPLICIT_NAMES[upperCode] || []),
    ...staticTokens,
  ], lower);
  if (explicitNameScore > 0) return 500 + explicitNameScore;
  return tokenMatchSpecificity(cantonNames, lower);
}

function strongestCantonSignal(text = '', codes = []) {
  let best = { code: '', score: 0 };
  for (const code of codes) {
    const score = strongCantonSignalScore(text, code);
    if (score > best.score) best = { code, score };
  }
  return best.code;
}

/**
 * Infer canton from text, checking only TARGET_CANTONS.
 * Returns 2-letter code or ''.
 */
export function inferSwissTargetCanton(text = '') {
  // Pass 0: explicit trailing canton-code suffix — the strongest possible
  // signal, including the parenthesized Swiss address form, checked across all
  // target cantons before any name/city match.
  for (const code of TARGET_CANTONS) {
    if (hasExplicitCantonMarker(text, code)) return code;
  }
  // Pass 1: curated name/code signal, across all target cantons — wins
  // regardless of TARGET_CANTONS array order. Longer, more specific canton
  // names win over shorter aliases from another canton.
  const strong = strongestCantonSignal(text, TARGET_CANTONS);
  if (strong) return strong;
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
  // including the parenthesized Swiss address form, wins regardless of which
  // canton's name/city list would otherwise match.
  for (const code of Object.keys(SWISS_CANTONS)) {
    if (hasExplicitCantonMarker(text, code)) return code;
  }

  // Pass 1: curated name/code signal, across ALL 26 cantons.
  const strong = strongestCantonSignal(text, Object.keys(SWISS_CANTONS));
  if (strong) return strong;

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

export function isTargetSwissLocation(text = '', {
  includeGrigioni = true,
  includeBorderProximity = true,
  includeAllCantons = false,
} = {}) {
  // The default preserves the legacy target scope. CH-wide crawlers must opt
  // into the complete canton registry explicitly, while foreign locations are
  // still rejected by isCantonRelevant.
  const cantonCodes = includeAllCantons ? ALL_CANTON_CODES : TARGET_CANTONS;
  for (const code of cantonCodes) {
    if (code === 'GR' && !includeGrigioni) continue;
    if (isCantonRelevant(text, code, { includeBorderProximity })) return true;
  }
  return false;
}

// Country-level word tokens that identify Switzerland without a city/canton.
const SWISS_COUNTRY_RE = /\b(switzerland|schweiz|suisse|svizzera|swiss)\b/i;

// "Deutschschweiz", "Ostschweiz", "Zentralschweiz": the country word as the
// head of a regional compound.
const SWISS_REGION_COMPOUND_RE = /schweiz\b/i;

/**
 * Strict Swiss signal of a LOCATION FIELD: the country word (also as the head
 * of "Deutschschweiz"), a canton name or code, or a BFS municipality — also a
 * bare name BFS only lists with a canton suffix ("Bremgarten") — but not a
 * border town (Como, Evian), which is foreign. False means the field names no
 * Swiss place at all, i.e. unknown geography for callers that keep it
 * fail-closed (#9846).
 */
export function locationFieldHasSwissSignal(text = '') {
  const s = String(text || '');
  if (!s.trim()) return false;
  return SWISS_COUNTRY_RE.test(s)
    || SWISS_REGION_COMPOUND_RE.test(s)
    || swissMunicipalityCantons(s).length > 0
    || isTargetSwissLocation(s, { includeBorderProximity: false, includeAllCantons: true });
}

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
  // A canton’s `names` alias list (used for keyword-relevance matching, see
  // strongCantonSignalScore) folds in representative CITY names for cantons
  // whose own name is rarely written out (e.g. BL: "Allschwil", "Reinach",
  // "Muttenz"...) to strengthen fuzzy canton detection in free text.
  // Reusing that same list for _cantonOnlyTokens would wrongly classify a
  // real, precise municipality match as a bare canton-only label — a real
  // city carries FULL location precision, the opposite of what this
  // function is meant to detect. A known city always wins.
  if (isKnownSwissCity(text)) return false;
  return _cantonOnlyTokens.has(token);
}

// Manual aliases are intentionally stored as a flat list in the BFS snapshot.
// These two entries are different: Davos Platz and Davos Glaris are
// sub-localities of the municipality Davos, not municipalities in their own
// right. Keep the relationship here until the snapshot schema can carry an
// explicit parent field; canonical consumers must compare the parent commune.
const MUNICIPALITY_ALIAS_PARENT_BY_TOKEN = new Map([
  ['davos platz', 'davos'],
  ['davos glaris', 'davos'],
]);

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
      if (!token || map.has(token)) continue;
      const parentToken = MUNICIPALITY_ALIAS_PARENT_BY_TOKEN.get(token);
      map.set(token, parentToken ? (map.get(parentToken) || name) : name);
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
  // #9846 (assembler replay on the slices of 2026-09-25): the company name in
  // "F. Hoffmann-La Roche" and in "la Roche Diagnostics", "de la Roche" —
  // 14 Roche postings abroad (Mississauga, Penzberg, Tucson, Tunis, …)
  // shipped as La Roche (FR).
  'la roche',
]);

// ─── Free-text scan with Unicode word boundaries (#9846) ───────────────────
// Description text is prose, so the scan works on WORDS as the text wrote them
// rather than on the ASCII-folded string findSwissCityInText() uses for
// location fields. Folding throws away three things that decide whether a
// municipality name in prose is really a place:
//
//   - the word boundary itself: folding turns every non-ASCII letter into a
//     separator, so "Großdietwil" (Grossdietwil, LU) became the words "gro"
//     + "dietwil", i.e. Dietwil (AG). A word here is a maximal run of Unicode
//     letters, marks and digits, folded only by stripping the accents. Always
//     applied;
//   - the hyphen: "Baden-Württemberg" is one foreign toponym, not the Aargau
//     town Baden followed by a second word, and "Hoffmann-La Roche" is a
//     company name, not the Fribourg village La Roche;
//   - the case: "tenero" (IT "tender") and "leuk" (NL "nice") are adjectives,
//     "la Roche" is the article before a company name; the villages are written
//     Tenero, Leuk, La Roche.
//
// The last two decide only in the foreign context of rescueSwissCityFromText():
// a job with a Swiss locality or postcode may well be in "Baden-Dättwil" or
// "Estavayer-le-Lac", and there the compound is Swiss.
const FREE_TEXT_WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
// A compound is two words joined by a hyphen with no space around it; a spaced
// dash ("Basel - Zürich") separates two places instead.
const COMPOUND_JOIN_RE = /^[-\u2010\u2011]$/u;
// An e-mail address or URL is an identifier, written in lower case whatever it
// names: "fisiocare.lugano@gmail.com" names Lugano as much as "Lugano" does.
const IDENTIFIER_RE = /@|:\/\/|^www\./iu;

function foldFreeTextWord(word) {
  return word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function tokenizeFreeText(text) {
  const words = [];
  for (const match of text.matchAll(FREE_TEXT_WORD_RE)) {
    words.push({ raw: match[0], folded: foldFreeTextWord(match[0]), start: match.index, end: match.index + match[0].length });
  }
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    words[i].joinsNext = Boolean(next) && COMPOUND_JOIN_RE.test(text.slice(words[i].end, next.start));
  }
  // Same length floor as findSwissCityInText(): one-letter words ("l'", "d'")
  // never take part in a candidate.
  return words.filter((word) => word.folded.length >= 2);
}

/**
 * True when the candidate words[i..j] sit inside a longer hyphenated compound
 * that is not itself Swiss: "Baden-Württemberg", "Hoffmann-La Roche". The whole
 * compound being a Swiss name ("Basel-Stadt") or every other part being a Swiss
 * place ("Zürich-Oerlikon") keeps the match.
 */
function isInsideForeignCompound(words, i, j) {
  let first = i;
  while (first > 0 && words[first - 1].joinsNext) first--;
  let last = j;
  while (last < words.length - 1 && words[last].joinsNext) last++;
  if (first === i && last === j) return false;
  const compound = words.slice(first, last + 1).map((word) => word.folded).join(' ');
  if (_allSwissCityTokens.has(compound)) return false;
  const rest = [...words.slice(first, i), ...words.slice(j + 1, last + 1)];
  return !rest.every((word) => _allSwissCityTokens.has(word.folded));
}

/**
 * True when the text writes the candidate as the proper noun it would be if it
 * named the municipality: every word the BFS name capitalises starts with a
 * capital here too. "la Roche", "tenero", "leuk" fail; "Zurich" for Zürich,
 * "ZÜRICH" and "La Chaux-de-Fonds" pass, and so does a name inside an e-mail
 * address or URL.
 */
function isWrittenAsProperNoun(text, words, i, j, canonicalName) {
  let from = words[i].start;
  while (from > 0 && !/\s/u.test(text[from - 1])) from--;
  let to = words[j].end;
  while (to < text.length && !/\s/u.test(text[to])) to++;
  if (IDENTIFIER_RE.test(text.slice(from, to))) return true;
  const canonicalWords = canonicalName.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  const aligned = canonicalWords.length === j - i + 1;
  for (let k = i; k <= j; k++) {
    const mustBeCapital = aligned ? /^\p{Lu}/u.test(canonicalWords[k - i]) : k === i;
    if (mustBeCapital && !/^\p{Lu}/u.test(words[k].raw)) return false;
  }
  return true;
}

// The employer's headquarters, not the job's workplace. The owner's rule for
// unknown geography is "no HQ fallback" (#9846): "mit Hauptsitz in Winterthur,
// Schweiz" in a Schkopau posting says where Sulzer is registered, and so does
// its Italian version "con sede a Winterthur" ("sede di lavoro", the
// workplace, is not a cue).
const HQ_CUE_BEFORE_RE = /(?:hauptsitz|hauptquartier|firmensitz|konzernsitz|stammsitz|headquarter(?:s|ed)?|head\s+office|\bhq|si[eè]ge(?:\s+social)?|quartier\s+g[eé]n[eé]ral|sede\s+(?:centrale|principale|legale|sociale)|con\s+sede|casa\s+madre)\b[^.;:!?\n]{0,30}$/iu;
// A clause is cut at sentence punctuation and brackets: "(u. a. Penzberg,
// Basel, Oceanside, Vacaville und South San Francisco)".
const CLAUSE_BREAK_RE = /[.;:!?()[\]\n•|]/u;
const LIST_ITEM_SPLIT_RE = /\s*(?:,|\/|&|\s(?:und|and|et|e|y|or|oder|ou|o)\s)\s*/iu;

/**
 * True when the candidate is one entry of a list of sites that also names a
 * place abroad: "offices across Geneva, Zurich, Barcelona, London",
 * "Penzberg, Basel, Oceanside, … South San Francisco". Such a list is the
 * employer's international footprint, not where this job is. A list of Swiss
 * sites only ("Luzern, Sursee und Wolhusen") still places the job in
 * Switzerland and keeps its match.
 */
function isInForeignSiteList(text, start, end, isForeignPlace) {
  if (typeof isForeignPlace !== 'function') return false;
  let from = start;
  while (from > 0 && !CLAUSE_BREAK_RE.test(text[from - 1])) from--;
  let to = end;
  while (to < text.length && !CLAUSE_BREAK_RE.test(text[to])) to++;
  const before = text.slice(from, start);
  const after = text.slice(end, to);
  // A candidate with no list separator right next to it is prose, not a list
  // entry.
  if (!LIST_ITEM_SPLIT_RE.test(before.slice(-8)) && !LIST_ITEM_SPLIT_RE.test(after.slice(0, 8))) return false;
  return [...before.split(LIST_ITEM_SPLIT_RE), ...after.split(LIST_ITEM_SPLIT_RE)]
    // A list entry is a place name of at most four words. The first and last
    // entries run into the prose around the list ("Avec des bureaux à
    // Genève"), so a longer item is read by its first and last four words.
    .flatMap((item) => {
      const itemWords = item.trim().split(/\s+/u).filter(Boolean);
      if (itemWords.length <= 4) return [itemWords.join(' ')];
      const edges = [];
      for (let k = 1; k <= 4; k++) edges.push(itemWords.slice(0, k).join(' '), itemWords.slice(-k).join(' '));
      return edges;
    })
    // Two-letter entries are department labels far more often than country
    // codes ("Sales, IT, Finance").
    .filter((phrase) => phrase.length >= 3)
    .some((phrase) => isForeignPlace(phrase));
}

/**
 * Guarded description-text rescue: returns the canonical name of the Swiss
 * municipality the text names, or '' when it names none that can be trusted.
 * Same scan order as findSwissCityInText() (three-word names first, then two,
 * then one), on Unicode words (see above), with these guards:
 *
 * - not an everyday word or company name (TEXT_RESCUE_AMBIGUOUS_TOKENS);
 * - the first name found must be ≥4 characters, otherwise there is no rescue:
 *   "Zug" (DE "train") never qualifies. The ≥4-char rule alone let through
 *   "Alle", "Root", "Rolle", "Fully" and "Bulle", ~1.4k mislocated jobs, hence
 *   the blocklist. A short name still ends the scan, as before #9846: the A/B
 *   of that PR measured that scanning past it re-admits German postings in
 *   "Neuenburg am Rhein" as Neuchâtel and moves the city of ~40 Swiss rows;
 * - with `foreignContext`, set by a caller whose own locality names no Swiss
 *   place (unknown geography, fail-closed per the owner's rule, #9846), four
 *   more: the name is not part of a foreign hyphenated compound
 *   (Baden-Württemberg), it is written as a proper noun (articles and common
 *   words fail), it is not the employer's headquarters, and it is not one
 *   entry of a list of sites that names a place abroad. `isForeignPlace`
 *   recognises those places; without it the list guard is off.
 *
 * A blocklisted or guarded name does not stop the scan. Single source of truth
 * for every DESCRIPTION-text rescue call site — never inline the raw
 * canonicalSwissCityName(findSwissCityInText(...)) expression instead. To pull
 * a city out of a location FIELD, use swissCityFromLocationField() below.
 *
 * @param {string} text
 * @param {{ foreignContext?: boolean, isForeignPlace?: (item: string) => boolean }} [options]
 * @returns {string}
 */
export function rescueSwissCityFromText(text = '', { foreignContext = false, isForeignPlace } = {}) {
  if (!text || typeof text !== 'string') return '';
  const words = tokenizeFreeText(text);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const j = i + n - 1;
      const candidate = words.slice(i, j + 1).map((word) => word.folded).join(' ');
      if (TEXT_RESCUE_AMBIGUOUS_TOKENS.has(candidate) || !_strictSwissCityTokens.has(candidate)) continue;
      if (candidate.length < 4) return '';
      const canonicalName = canonicalSwissCityName(candidate);
      if (foreignContext) {
        const start = words[i].start;
        const end = words[j].end;
        if (isInsideForeignCompound(words, i, j)) continue;
        if (!isWrittenAsProperNoun(text, words, i, j, canonicalName)) continue;
        if (HQ_CUE_BEFORE_RE.test(text.slice(Math.max(0, start - 60), start))) continue;
        if (isInForeignSiteList(text, start, end, isForeignPlace)) continue;
      }
      return canonicalName;
    }
  }
  return '';
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
