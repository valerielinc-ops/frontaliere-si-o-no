import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TARGET_CANTONS, SWISS_CANTONS, isTargetCanton } from './crawler-location-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

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

// ─── Load municipality data from BFS-generated JSON ────────────────────────

function loadMunicipalityData() {
  try {
    const raw = readFileSync(join(DATA_DIR, 'canton-municipalities.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    console.warn('⚠️  canton-municipalities.json not found — run: npm run data:municipalities');
    return { cantons: {} };
  }
}

const MUNICIPALITY_DATA = loadMunicipalityData();

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
  const tokens = all
    .map((city) => normalizeToken(city))
    .filter((token) => token && !AMBIGUOUS_LOCATION_WORD_TOKENS.has(token));

  _cantonCityTokensCache.set(cantonCode, tokens);
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
 */
export function isKnownSwissMunicipality(cityName = '') {
  const token = normalizeToken(cityName);
  if (!token || token.length < 2) return false;
  return _allSwissCityTokens.has(token);
}

/**
 * Strict variant: matches only known Swiss CITIES (BFS municipalities +
 * aliases). Canton names ("Ticino", "Graubünden", "Tessin") return false.
 *
 * Use this when validating crawler output: a job whose addressLocality
 * is just a canton name has no real city and likely indicates a misclassified
 * record (the actual location is buried in the description body).
 */
export function isKnownSwissCity(cityName = '') {
  const token = normalizeToken(cityName);
  if (!token || token.length < 2) return false;
  return _strictSwissCityTokens.has(token);
}

/**
 * True iff the input is just a canton name/code (e.g. "Ticino", "TI",
 * "Graubünden", "GR"). False for cities and anything else.
 */
export function isCantonOnlyLabel(text = '') {
  const token = normalizeToken(text);
  if (!token) return false;
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
 */
export function findSwissCityInText(text = '') {
  if (!text || typeof text !== 'string') return '';
  const norm = normalizeToken(text);
  if (!norm) return '';
  // Tokenise on whitespace; bigrams + trigrams catch multi-word cities
  // like "La Chaux-de-Fonds", "Saint-Gall".
  const words = norm.split(' ').filter((w) => w.length >= 2);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const candidate = words.slice(i, i + n).join(' ');
      if (_strictSwissCityTokens.has(candidate)) return candidate;
    }
  }
  return '';
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
