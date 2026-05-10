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
  const tokens = all.map((city) => normalizeToken(city));

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
export function isCantonRelevant(text = '', cantonCode = '') {
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

  // 5. Border proximity keywords (only for cantons that have them)
  const borderKeywords = BORDER_PROXIMITY_BY_CANTON[code];
  if (borderKeywords?.some((keyword) => lower.includes(keyword))) return true;

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

/**
 * Infer canton from text, checking only TARGET_CANTONS.
 * Returns 2-letter code or ''.
 */
export function inferSwissTargetCanton(text = '') {
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
  // Check target cantons first (fast path for common cases)
  const target = inferSwissTargetCanton(text);
  if (target) return target;

  // Check all other cantons using full isCantonRelevant (BFS + names + aliases)
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

export function isTargetSwissLocation(text = '', { includeGrigioni = true } = {}) {
  for (const code of TARGET_CANTONS) {
    if (code === 'GR' && !includeGrigioni) continue;
    if (isCantonRelevant(text, code)) return true;
  }
  return false;
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
