// scripts/lib/discovery/domainAnchor.mjs
//
// Single source of truth for "does this candidate look like it's about
// Ticino frontalieri?". Used to gate the discovery suggest source so
// generic Italian autocomplete (e.g. "mobilita palermo", "salute roma")
// can never be mistaken for a Ticino mobility/health topic.
//
// Why this exists:
//   2026-05-11 incident — `mobilita-palermo-frontalieri-ticino` was
//   published. Root cause: `pickClusterSeeds` in googleSuggestSource.mjs
//   passed bare cluster names (`mobilita`) as Google Suggest seeds.
//   Suggest returned "mobilita palermo" (a real Italian search trend
//   tied to the Palermo mobility crisis). The cluster classifier then
//   confirmed cluster=mobilita on the literal token, the discovery
//   score multiplied cluster_p50 * 0.6 to a high number, and the
//   embedding cascade matched it to "palma-muralto-..." (string-prefix
//   noise, not topic similarity). Article published.
//
// The fix is structural: every discovery candidate that comes from a
// generic-keyword source MUST mention at least one domain anchor before
// it can enter the ranker. Anchors come from two sources:
//
//   A. ANCHOR_TOKENS — curated regex of concepts + institutional words
//      + Italian-side border towns + frontalieri-specific vocabulary
//      (frontaliere, permesso G, AVS, LPP, LAMal, telelavoro, ristorni,
//      federale, cantonale, secondo pilastro, …).
//
//   B. CH_MUNICIPALITY_SET — every Swiss municipality (~2,100 entries
//      across all 26 cantons), loaded from data/canton-municipalities.json.
//      Multi-word names (e.g. "Riva San Vitale", "Beinwil am See") are
//      matched via a sliding 1-3-token window against the normalized set.
//      Names in parentheses ("Arni (AG)" → "arni") are stripped during
//      normalization. Entries shorter than 3 chars are dropped to avoid
//      collisions with common Italian words.
//
// We deliberately keep ANCHOR_TOKENS explicit and tight, and let the
// municipality Set carry the long-tail toponym coverage. False negatives
// (real Ticino topics rejected) are recoverable by adding the missing
// token. False positives (Palermo articles published) are not.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const ANCHOR_TOKENS = [
  // Core domain words
  // 2026-05-11 audit: broadened — `frontalier[ei]?` was missing
  // "frontaliero" (m. sing.); `svizzer[ao]` was missing "svizzeri"
  // (m. pl.) and "svizzere" (f. pl.). Caused 11/15 false positives in
  // the slug-anchor backfill audit. See domainAnchor.test.ts regression
  // block for the full list.
  'frontalier[aeio]',
  'ticin(o|esi?)',
  'svizzer[aeio]',
  'svizzera',
  'svizzeri',
  '\\bch\\b',
  '\\bchf\\b',
  '\\bswiss\\b',
  'cross.?border',
  'grenzg(?:a|ae|ä)nger',
  // Swiss federal/cantonal institutions — "votazioni federali",
  // "giudici federali", "polizia cantonale", "consiglio cantonale".
  'federal[ei]',
  'cantonal[ei]',
  'confederazion',

  // Cross-border concepts
  'permesso\\s*[gb]',
  'permesso\\s*frontaliere',
  'telelavoro',
  'smart\\s*working\\s*frontalier',
  'ristorni',
  '\\bavs\\b',
  '\\bahv\\b',
  '\\blpp\\b',
  '\\blamal\\b',
  'cassa\\s*malati',
  'busta\\s*paga\\s*svizzer',
  'dichiarazione\\s*frontalieri',
  'nuovo\\s*accordo\\s*fiscale',
  'pendolar(i|ismo)\\s*svizzer',
  // "secondo pilastro" / "terzo pilastro" / "pilastro 3a" — Italian
  // for the LPP / pension fund pillars. Standalone "pilastro" alone is
  // ambiguous (Pilastro is also a Bologna neighborhood); we require it
  // to follow an ordinal (secondo/terzo) or letter+digit (3a/3b).
  '(?:secondo|terzo)\\s*pilastro',
  'pilastro\\s*3[ab]',

  // Ticino toponyms (curated — the ones that recur in our slug-registry)
  'lugano',
  'chiasso',
  'mendrisio',
  'locarno',
  'bellinzona',
  'biasca',
  'airolo',
  'stabio',
  'coldrerio',
  'balerna',
  'gordola',
  'massagno',
  'paradiso',
  'riva\\s*san\\s*vitale',
  'melide',
  'morbio',
  'rancate',
  'capolago',
  'caslano',
  'breganzona',
  'comano',
  'cadempino',
  'manno',
  'magliaso',
  'montagnola',
  'gentilino',
  'tesserete',
  'sementina',
  'giubiasco',
  'losone',
  'minusio',
  'orselina',
  'tenero',
  'cugnasco',
  'maggia',
  'cevio',
  'brissago',
  'ascona',
  'agno',
  'taverne',
  'arbedo',
  'mezzovico',
  'muralto',
  // 2026-05-11 audit additions — TI micro-toponyms appearing in slugs:
  'san\\s*antonino',
  'cornaredo',          // Lugano stadium
  'cardada',            // Cardada-Cimetta (Locarno)
  'cimetta',
  'vedeggio',           // valle / fiume Ticino
  'malcantone',
  'leventina',
  'blenio',
  'bedretto',
  'verzasca',
  'onsernone',
  'centovalli',
  'mendrisiotto',
  'luganese',
  'bellinzonese',
  'locarnese',
  'gambarogno',
  // Ticino highways used daily by frontalieri (slugs use hyphens, so
  // accept `\\s` OR `-` between "autostrada" and the road code):
  'autostrada[\\s-]*a[2913]\\b',
  '\\ba[2913][\\s-]*(?:autostrada|svizzer|ticin)',

  // Border IT towns where frontalieri live
  'como',
  'varese',
  'verbania',
  'sondrio',
  'lecco',
  'campione\\s*d',
  'maslianico',
  'cernobbio',
  'porlezza',
  'menaggio',
  'tirano',
  'luino',
  'gravedona',
  // 2026-05-11 audit additions — IT regions that source frontalieri:
  'ossola',
  'ossolan[ao]',
  'val\\s*d.?ossola',
  'cislago',
  'cittiglio',
  'laveno',
  'cantello',
  'gallarate',
  'busto\\s*arsizio',
  'erba\\b',
  'mariano',
  'cantu',
  'cantù',
  'merate',
  'olgiate',
  'ponte\\s*tresa',
  'cuasso',
  'malnate',
  'arcisate',
  'varesotto',
  'comasco',

  // Other CH cantons & cities that recur in cross-border content
  'berna',
  'berne',
  'zurigo',
  'zürich',
  'zurich',
  'basilea',
  'basel',
  'ginevra',
  'geneva',
  'gen[èe]ve',
  'losanna',
  'lausanne',
  'romandia',
  'romand',
  'vallese',
  'valais',
  'argovia',
  'aargau',
  'vaud',
  'sangallo',
  'st\\.?\\s*gallen',
  'grigioni',
  'graub[üu]nden',
  'briga',
  'brig',
  // 2026-05-11 audit additions — CH cantons / cities still missing:
  'friburgo',
  'fribourg',
  'lucerna',
  'luzern',
  'sciaffusa',
  'schaffhausen',
  'neuchâtel',
  'neuchatel',
  'neuenburg',
  'giura\\b',
  '\\bjura\\b',
  'soletta',
  'solothurn',
  'glarona',
  'glarus',
  'uri\\b',
  'svitto',
  'schwyz',
  'zugo',
  'zug\\b',
  'appenzello',
  'appenzell',
  'nidvaldo',
  'nidwalden',
  'obvaldo',
  'obwalden',
  'turgovia',
  'thurgau',
  'visp\\b',
  'sion\\b',
  'martigny',
  'crans.?montana',
  'verbier',
  'zermatt',
  'davos',
  'st\\.?\\s*moritz',
  'gstaad',
  'interlaken',
  'thun\\b',
];

const DOMAIN_ANCHOR_RE = new RegExp(`\\b(?:${ANCHOR_TOKENS.join('|')})\\b`, 'i');

// ── Municipality lookup (CH + IT border) ─────────────────────────────
//
// Two datasets, loaded once at module init and merged into a single
// normalized Set:
//
//   1. data/canton-municipalities.json — BFS snapshot of all ~2,100
//      Swiss municipalities across the 26 cantons.
//   2. data/municipalities.ts — official ti.ch list of 518 Italian
//      "comuni di frontiera" (border municipalities where frontalieri
//      live, across CO/VA/VB/SO/LC/BG/BS).
//
// Normalization: lowercased, parentheticals stripped ("Arni (AG)" →
// "arni"), internal whitespace collapsed, multi-word names preserved
// (matched via 1-3 token sliding window in `hasSwissMunicipality`).
// Entries shorter than MIN_NAME_LEN are dropped to avoid collisions
// with common Italian/English words ("Or" the Bern town vs the
// conjunction; "Uri" the canton vs other senses).

const MIN_NAME_LEN = 4;
const MAX_NAME_TOKENS = 3;

function normalizeMunicipalityName(raw) {
  if (typeof raw !== 'string') return '';
  // Strip parenthetical canton/region disambiguators: "Arni (AG)" → "Arni",
  // "Beinwil (Freiamt)" → "Beinwil". Collapse internal whitespace.
  return raw
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function addCleanedNamesToSet(set, names) {
  if (!Array.isArray(names)) return;
  for (const name of names) {
    const norm = normalizeMunicipalityName(name);
    if (norm.length >= MIN_NAME_LEN) set.add(norm);
  }
}

function loadCantonMunicipalities(set, dataDir) {
  try {
    const raw = JSON.parse(readFileSync(resolvePath(dataDir, 'canton-municipalities.json'), 'utf8'));
    if (raw && raw.cantons && typeof raw.cantons === 'object') {
      for (const canton of Object.values(raw.cantons)) {
        addCleanedNamesToSet(set, canton?.municipalities);
      }
    }
  } catch {
    // Non-fatal — curated tokens still cover the common cases.
  }
}

function loadItalianBorderMunicipalities(set, dataDir) {
  try {
    // data/municipalities.ts is hand-edited TypeScript (518 ti.ch comuni
    // di frontiera). Parse the `name: '...'` literals via regex — keeps
    // this module dependency-free and avoids needing a TS loader at
    // runtime. If the format ever changes to an exported JSON, swap
    // this for a plain JSON.parse.
    const source = readFileSync(resolvePath(dataDir, 'municipalities.ts'), 'utf8');
    const names = [];
    for (const match of source.matchAll(/name:\s*'([^']+)'/g)) {
      names.push(match[1]);
    }
    addCleanedNamesToSet(set, names);
  } catch {
    // Non-fatal.
  }
}

function loadMunicipalitySet() {
  // Resolve via this file's own location so the lookup works whether
  // we're running from the repo root, a worktree, or a script context.
  const here = dirname(fileURLToPath(import.meta.url));
  // scripts/lib/discovery/ → repo root → data/
  const dataDir = resolvePath(here, '..', '..', '..', 'data');
  const set = new Set();
  loadCantonMunicipalities(set, dataDir);
  loadItalianBorderMunicipalities(set, dataDir);
  return set;
}

const CH_MUNICIPALITY_SET = loadMunicipalitySet();

function tokenizeForLookup(text) {
  // Split on anything that isn't a letter/digit/apostrophe; keep the
  // accented latin-1 range so "Neuchâtel" stays one token.
  return String(text).toLowerCase().match(/[a-z0-9à-ÿ']+/g) || [];
}

/**
 * Test whether `text` references a Swiss municipality (single- or
 * multi-word, up to MAX_NAME_TOKENS tokens) by checking every 1..N
 * consecutive token slice against the BFS-derived municipality set.
 *
 * Exported for testing; in normal use call hasDomainAnchor.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function hasSwissMunicipality(text) {
  if (!text || typeof text !== 'string') return false;
  if (CH_MUNICIPALITY_SET.size === 0) return false;
  const tokens = tokenizeForLookup(text);
  for (let i = 0; i < tokens.length; i += 1) {
    const limit = Math.min(MAX_NAME_TOKENS, tokens.length - i);
    for (let span = 1; span <= limit; span += 1) {
      const phrase = tokens.slice(i, i + span).join(' ');
      if (CH_MUNICIPALITY_SET.has(phrase)) return true;
    }
  }
  return false;
}

/**
 * Test whether `text` mentions any token that anchors it to the
 * Ticino-frontalieri domain. Returns false for null/empty input.
 *
 * Two-stage check: curated regex first (fast, covers concepts +
 * cross-border vocabulary), municipality Set second (covers every
 * Swiss town).
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function hasDomainAnchor(text) {
  if (!text || typeof text !== 'string') return false;
  if (DOMAIN_ANCHOR_RE.test(text)) return true;
  return hasSwissMunicipality(text);
}

/**
 * Append the canonical anchor suffix to a bare seed term so Google
 * Suggest returns Ticino-relevant completions. Idempotent: a seed that
 * already contains an anchor is returned unchanged.
 *
 * @param {string} seed
 * @returns {string}
 */
export function anchorSeed(seed) {
  const s = typeof seed === 'string' ? seed.trim() : '';
  if (!s) return s;
  if (hasDomainAnchor(s)) return s;
  return `${s} frontalieri`;
}

export { DOMAIN_ANCHOR_RE, CH_MUNICIPALITY_SET };
