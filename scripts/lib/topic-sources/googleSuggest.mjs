// scripts/lib/topic-sources/googleSuggest.mjs
//
// Pulls autocomplete completions from Google Suggest for a static seed
// list. Endpoint:
//   https://suggestqueries.google.com/complete/search?client=firefox&hl=it&q=<seed>
//
// Response is a JSON array shaped:
//   ["seed", ["completion1", "completion2", ...], [], {...}]
//
// Empirical: ~10 completions per seed in the IT locale, no rate-limit
// observed under typical CI volume. Used by the Phase A demand-vocabulary
// aggregator as the "suggest" stable signal.
//
// Resilience:
//   - Each request wrapped in try/catch; module never throws.
//   - 5s per-request timeout; one retry on transient error.
//   - Per-seed graceful degradation: one seed fails, others continue.
//   - HTTP 429 / non-200 → empty result for that seed with `reason`.
//   - Malformed JSON → empty result for that seed with `reason`.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';

// DENYLIST: Google Suggest sometimes autocompletes a seed into the wrong
// sense — e.g. seed "permesso G" returns "permesso gratuito pesca in
// mare" / "permesso caccia" / "permesso giornaliero ZTL firenze" because
// the user-base searching for "permesso" includes hobby/admin/civic
// contexts that have nothing to do with the work-permit "permesso G".
// Drop completions matching any of these false-positive senses to keep
// the demand-vocab focused on cross-border work signals.
//
// `ztl` covers traffic-zone permits in IT cities (firenze/bologna/milano);
// `giornaliero` (daily) is almost never used for work permits and almost
// always for ZTL/parcheggio/cantiere contexts.
//
// BUSINESS-NAME false-positives: Suggest sometimes returns hotel/retail
// chain names that contain "lamal", "lpp", "permesso" as substrings —
// "lamal hotel napoli", "lppcollecting", "permesso parcheggio condominio".
// Drop completions that look like product / business / handle names.
const DENYLIST_RE =
  /\b(pesca|caccia|edilizia|parcheggio|animale|matrimonio|soggiorno\s*per\s*studio|funebre|riposo|servizio\s*civile|condono\s*edilizio|ztl|zona\s*traffico\s*limitato|giornaliero|cantiere|circolazione|disabil[ie]|invalid[oi]|temporaneo\s*per\s*[a-z]+|funerale|comunale|abitativo|hotel|casino|boutique|chain|\bsrl\b|\bspa\b|s\.r\.l|s\.p\.a|collecting|ware|condominio|napoli\b|firenze\b|milano\s+ztl|bologna\s+ztl|patente\s*(sospesa|revocata)|permesso\s*guida|sostegn(o|i))\b/i;

// LAMAL TOPONYM/SURNAME collision: Suggest seed "LAMal" autocompletes
// to Italian toponyms / surnames / brands containing "lamal" as a
// substring (lamalfa = surname, lamalegno/lamalunga = small towns,
// lamalaser = laser-brand product, lamaline = product, altamura =
// town near "lamal*"). These are unrelated to LAMal Swiss insurance.
const LAMAL_NOISE_RE =
  /\b(lamalfa(\d+)?|lamalegno|lamalung[ae]|lamalaser|lamaline|altamura|lamal\s+hotel)\b/i;

// LPP RETAIL/LEGAL collision: Suggest seed "LPP" autocompletes to
// "LPP Italy" (retail chain), "LPP Arcore" (regional branch), "LPP SA"
// (corporate suffix), "LPPP" (typo). These collide with the Swiss LPP
// pension fund. Note `\blpp\s+(italy|sa|arcore|spa|srl)\b` catches
// the multi-word forms; `\blppp\b` catches the typo.
const LPP_RETAIL_RE =
  /\b(lpp\s+(italy|sa|arcore|spa|srl|cos['’]?\s*è)|\blppp\b)\b/i;

// TOKENIZER ARTIFACT: Suggest sometimes returns concatenated single-
// word strings like "lppcollecting" (which should have been "lpp
// collecting"). Reject single-token kw of length > 10 that start with
// a known seed prefix without a space — these are almost always
// tokenizer noise from the Suggest endpoint.
const TOKENIZER_ARTIFACT_RE =
  /^(lpp|lamal|permesso|frontalier|avs|ahv|pilastro)[a-z]{6,}$/i;

function passesDenylist(completion) {
  if (typeof completion !== 'string') return false;
  if (DENYLIST_RE.test(completion)) return false;
  if (LAMAL_NOISE_RE.test(completion)) return false;
  if (LPP_RETAIL_RE.test(completion)) return false;
  if (TOKENIZER_ARTIFACT_RE.test(completion.trim())) return false;
  return true;
}

// keep in sync with googleTrends.mjs SEEDS_FALLBACK
const SEEDS_FALLBACK = [
  'frontaliere',
  'frontalieri',
  'permesso G',
  'tasse svizzera',
  'LPP',
  'telelavoro frontalieri',
  'ristorni frontalieri',
  'AVS frontalieri',
  'LAMal',
  'CMI frontalieri',
  'IRPEF frontalieri',
  'busta paga svizzera',
  'nuovo accordo fiscale',
  'secondo pilastro',
];

const REQUEST_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 750;
const MAX_PER_SEED = 10;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    return await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// Parse the firefox-client suggest payload. Shape:
//   ["seed", ["completion1", "completion2", ...], [], {...}]
// Returns string[] of completions, or [] on any malformed input.
export function parseSuggestPayload(text) {
  if (!text || typeof text !== 'string') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return [];
  const completions = parsed[1];
  if (!Array.isArray(completions)) return [];
  return completions
    .map((c) => (typeof c === 'string' ? c.trim() : null))
    .filter((c) => !!c);
}

async function fetchOneSeed(seed, fetchImpl) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=it&q=${encodeURIComponent(
    seed,
  )}`;
  let lastReason = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, REQUEST_TIMEOUT_MS);
      if (!res || typeof res.ok !== 'boolean') {
        lastReason = 'invalid response';
      } else if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
      } else {
        const text = await res.text();
        const completions = parseSuggestPayload(text);
        if (!Array.isArray(completions)) {
          lastReason = 'malformed json';
        } else {
          return { ok: true, completions };
        }
      }
    } catch (e) {
      lastReason = `fetch error: ${e?.message ?? String(e)}`;
    }
    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }
  return { ok: false, completions: [], reason: lastReason ?? 'unknown error' };
}

/**
 * Fetch Google Suggest completions for each seed. Always resolves; never
 * throws. Per-seed graceful degradation: a single seed's failure is
 * captured in `perSeed[seed].reason` while other seeds continue.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.seeds] — defaults to SEEDS_FALLBACK.
 * @param {Function} [opts.fetchImpl] — test seam, defaults to globalThis.fetch.
 * @returns {Promise<{
 *   ok: boolean,
 *   perSeed: Record<string, {ok: boolean, candidates: any[], reason?: string}>,
 *   candidates: any[]
 * }>}
 */
export async function fetchSuggestCandidates(opts = {}) {
  const seeds = Array.isArray(opts.seeds) && opts.seeds.length ? opts.seeds : SEEDS_FALLBACK;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const empty = {};
    for (const seed of seeds) {
      empty[seed] = { ok: false, candidates: [], reason: 'no fetch implementation available' };
    }
    return { ok: false, perSeed: empty, candidates: [] };
  }

  const perSeed = {};
  const all = [];
  const seenNorm = new Set();

  for (const seed of seeds) {
    const { ok, completions, reason } = await fetchOneSeed(seed, fetchImpl);
    const seedCandidates = [];
    if (ok && completions.length) {
      // Apply denylist BEFORE the rank-cap so dropped entries don't push
      // a relevant completion below the cap.
      const filtered = completions.filter(passesDenylist);
      // rank 0 = top suggestion (highest weight). Cap at MAX_PER_SEED.
      const limited = filtered.slice(0, MAX_PER_SEED);
      for (let rank = 0; rank < limited.length; rank++) {
        const completion = limited[rank];
        const norm = normalizeKeyword(completion);
        if (!norm || seenNorm.has(norm)) continue;
        seenNorm.add(norm);
        seedCandidates.push({
          id: fnv1a8(norm),
          keyword: completion,
          normalizedKeyword: norm,
          angle: null,
          locale: 'it',
          sources: ['googleSuggest'],
          demandSignals: {
            googleSuggestSeed: seed,
            googleSuggestRank: rank,
          },
          rationale: `Google Suggest seed "${seed}" rank ${rank}`,
        });
      }
    }
    perSeed[seed] = ok
      ? { ok: true, candidates: seedCandidates }
      : { ok: false, candidates: [], reason };
    for (const c of seedCandidates) all.push(c);
  }

  const ok = Object.values(perSeed).some((s) => s.ok && s.candidates.length > 0);
  return { ok, perSeed, candidates: all };
}

export default fetchSuggestCandidates;
