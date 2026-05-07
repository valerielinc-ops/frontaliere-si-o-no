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
// mare" / "permesso caccia" / "permesso parcheggio disabili" because the
// user-base searching for "permesso" includes hobby/admin contexts that
// have nothing to do with the work-permit "permesso G". Drop completions
// matching any of these false-positive senses to keep the demand-vocab
// focused on cross-border work signals.
const DENYLIST_RE =
  /\b(pesca|caccia|edilizia|parcheggio|animale|matrimonio|soggiorno\s*per\s*studio|funebre|riposo|servizio\s*civile|condono\s*edilizio)\b/i;

function passesDenylist(completion) {
  if (typeof completion !== 'string') return false;
  return !DENYLIST_RE.test(completion);
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
