/**
 * Canton Quorum Gate
 * ==================
 *
 * Decision gate that classifies a job's canton with calibrated confidence.
 * Result feeds the SEO routing decision (E9 + E11): high-confidence jobs go
 * to per-canton landings, low-confidence stay on /cerca-lavoro-svizzera/.
 *
 * Gate flow (D7 — CEO review 2026-05-10):
 *
 *   job → reject (non-CH) → BFS-strict → 2-of-3 quorum → keep-as-is
 *               ✗              ✓high          ✓high           ✓low
 *                                              fallback
 *
 *   1. Reject if addressCountry exists and is not "CH".
 *   2. Reject if Liechtenstein detected (postal 9485-9498 or FL city name).
 *   3. BFS-strict: addressLocality is a known Swiss CITY (not a bare canton
 *      name/code label) → high.
 *   4. 2-of-3 quorum: title + body + addressLocality agree on canton, AND a
 *      real Swiss city (not just the canton's own name) is named in at least
 *      one field → high.
 *   5. Keep-as-is: low confidence, return existing canton tag (may be empty).
 *
 * The gate NEVER throws — every code path returns a structured result.
 */

import {
  isKnownSwissCity,
  inferAnyCanton,
  isLiechtensteinPostalCode,
  rescueSwissCityFromText,
} from './target-swiss-locations.mjs';

// ─── Constants ─────────────────────────────────────────────────────────────

const LIECHTENSTEIN_CITIES = new Set([
  'schaan',
  'vaduz',
  'triesen',
  'balzers',
  'eschen',
  'mauren',
  'ruggell',
  'triesenberg',
  'gamprin',
  'planken',
  'schellenberg',
]);

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Normalize free-form text for matching: NFC, lowercase, trimmed, single-spaced.
 * Returns '' for nullish or non-string input.
 */
function normalizeText(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Run inferAnyCanton defensively — never throws, always returns string.
 */
function safeInferCanton(text) {
  if (!text) return '';
  try {
    return inferAnyCanton(text) || '';
  } catch {
    return '';
  }
}

/**
 * Run isKnownSwissCity defensively. Strict (city-only) variant — excludes
 * bare canton name/code labels, see runBfsStrict below.
 */
function safeIsKnownCity(cityName) {
  if (!cityName) return false;
  try {
    return Boolean(isKnownSwissCity(cityName));
  } catch {
    return false;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Detect whether a job is in Liechtenstein (FL) rather than Switzerland (CH).
 * Liechtenstein shares CH-style 4-digit postcodes (9485-9498) and small city
 * names that the BFS-trained matcher may miss. Used to reject FL jobs.
 *
 * @param {string} text - Free-form text (addressLocality + description join is fine).
 * @param {string|number} [postalCode] - 4-digit postal code if available.
 * @returns {boolean}
 */
export function isLiechtenstein(text, postalCode) {
  if (isLiechtensteinPostalCode(postalCode)) return true;
  const norm = normalizeText(text);
  if (!norm) return false;
  for (const city of LIECHTENSTEIN_CITIES) {
    // Word-boundary match to avoid e.g. "Vaduz" inside an unrelated word.
    const re = new RegExp(`\\b${city}\\b`, 'i');
    if (re.test(norm)) return true;
  }
  return false;
}

/**
 * Strict primary path: only accept the canton if `addressLocality` is an
 * exact match for a known BFS Swiss municipality. This is the highest-trust
 * signal because the structured field came from the source ATS, not free text.
 *
 * Uses `isKnownSwissCity` (not the looser `isKnownSwissMunicipality`, which
 * also matches bare canton name/code aliases like "Ticino"/"TI") — a
 * canton-only label carries no real city-level precision and must not be
 * trusted as a "high" BFS-strict signal (issue #4570 class: a forged/weak
 * canton-only `addressLocality` silently overriding the job's real canton).
 *
 * @param {{ addressLocality?: string }} input
 * @returns {{ canton: string, confidence: 'high' | 'low' }}
 */
export function runBfsStrict({ addressLocality } = {}) {
  const locality = normalizeText(addressLocality);
  if (!locality) return { canton: '', confidence: 'low' };
  if (!safeIsKnownCity(locality)) {
    return { canton: '', confidence: 'low' };
  }
  const canton = safeInferCanton(locality);
  if (!canton) return { canton: '', confidence: 'low' };
  return { canton, confidence: 'high' };
}

/**
 * Fallback path: run inferAnyCanton on title, body, and addressLocality.
 * If 2 or more of the 3 signals agree on the same canton AND at least one of
 * the fields that actually VOTED for that canton names a Swiss CITY that
 * resolves to it → high confidence. Otherwise → low confidence (no agreed,
 * city-corroborated canton).
 *
 * The city-corroboration requirement closes the same #4570 bug class as
 * `runBfsStrict` above: `inferAnyCanton`'s "Pass 1" curated signal matches a
 * BARE canton name/code (e.g. "Ticino") with the same weight as a real city
 * match, so 2 of 3 fields merely repeating the canton's own name (common
 * boilerplate, no city anywhere) used to be enough to reach `high` with zero
 * city-level precision — same forged/weak canton-only signal the quorum is
 * meant to defend against, just doubled across fields instead of singular.
 *
 * Corroboration is scoped to the fields that VOTED for the winning canton
 * (#4617 follow-up item 2): a job whose title/addressLocality forge a canton
 * but whose body happens to name an unrelated real city in boilerplate (e.g.
 * a branch-office list or footer) resolving to that SAME canton must not
 * corroborate a vote the body itself didn't cast.
 *
 * @param {{ title?: string, body?: string, addressLocality?: string }} input
 * @returns {{ canton: string, confidence: 'high' | 'low' }}
 */
export function run2of3Quorum({ title, body, addressLocality } = {}) {
  const fields = [normalizeText(title), normalizeText(body), normalizeText(addressLocality)];
  const fieldVotes = fields.map(safeInferCanton);
  const signals = fieldVotes.filter(Boolean);

  if (signals.length < 2) return { canton: '', confidence: 'low' };

  const counts = new Map();
  for (const code of signals) {
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  for (const [code, count] of counts) {
    if (count < 2) continue;
    const votingFields = fields.filter((_, i) => fieldVotes[i] === code);
    const cityCorroborated = votingFields.some((text) => {
      const city = rescueSwissCityFromText(text);
      return Boolean(city) && safeInferCanton(city) === code;
    });
    if (cityCorroborated) return { canton: code, confidence: 'high' };
  }
  return { canton: '', confidence: 'low' };
}

/**
 * Apply the full canton quorum gate to a job record.
 *
 * Returns:
 *   - `{ canton, confidence: 'reject', cantonConfidence: 'reject' }` when the
 *     job is non-CH or in Liechtenstein. Caller MUST drop the job.
 *   - `{ canton, confidence: 'high', cantonConfidence: 'high' }` from BFS-strict
 *     or 2-of-3 quorum. Eligible for per-canton SEO landing.
 *   - `{ canton: job.canton || '', confidence: 'low', cantonConfidence: 'low' }`
 *     keep-as-is. E9: emit at /cerca-lavoro-svizzera/{slug}; E11: exclude
 *     from per-canton SEO landing.
 *
 * Never throws — defensive against missing/malformed fields.
 *
 * @param {{
 *   title?: string,
 *   description?: string,
 *   addressLocality?: string,
 *   addressRegion?: string,
 *   addressCountry?: string,
 *   postalCode?: string|number,
 *   canton?: string,
 * }} job
 * @returns {{
 *   canton: string,
 *   confidence: 'high' | 'low' | 'reject',
 *   cantonConfidence: 'high' | 'low' | 'reject',
 * }}
 */
export function applyCantonQuorumGate(job) {
  const safe = job && typeof job === 'object' ? job : {};
  const title = safe.title;
  const description = safe.description;
  const addressLocality = safe.addressLocality;
  const addressCountry = safe.addressCountry;
  const postalCode = safe.postalCode;
  const existingCanton = typeof safe.canton === 'string' ? safe.canton : '';

  // Step 1: non-CH country code → reject
  if (addressCountry) {
    const country = normalizeText(addressCountry).toUpperCase();
    if (country && country !== 'CH') {
      return { canton: '', confidence: 'reject', cantonConfidence: 'reject' };
    }
  }

  // Step 2: Liechtenstein → reject
  const flText = [addressLocality, description].filter(Boolean).join(' ');
  if (isLiechtenstein(flText, postalCode)) {
    return { canton: '', confidence: 'reject', cantonConfidence: 'reject' };
  }

  // Step 3: BFS-strict on addressLocality
  const bfs = runBfsStrict({ addressLocality });
  if (bfs.confidence === 'high' && bfs.canton) {
    return {
      canton: bfs.canton,
      confidence: 'high',
      cantonConfidence: 'high',
    };
  }

  // Step 4: 2-of-3 quorum across title / body / addressLocality
  const quorum = run2of3Quorum({
    title,
    body: description,
    addressLocality,
  });
  if (quorum.confidence === 'high' && quorum.canton) {
    return {
      canton: quorum.canton,
      confidence: 'high',
      cantonConfidence: 'high',
    };
  }

  // Step 5: keep-as-is — low confidence, fall back to existing tag
  return {
    canton: existingCanton || '',
    confidence: 'low',
    cantonConfidence: 'low',
  };
}

/**
 * Build a single-line audit string describing how the gate classified a job.
 * Useful for log-grep when investigating misclassifications. Never throws.
 *
 * @param {object} job
 * @param {{ canton: string, confidence: string, cantonConfidence?: string }} result
 * @returns {string}
 */
export function recordCantonInferenceTrace(job, result) {
  try {
    const safe = job && typeof job === 'object' ? job : {};
    const id = safe.id || safe.slug || safe.url || '<no-id>';
    const locality = safe.addressLocality || '';
    const country = safe.addressCountry || '';
    const postal = safe.postalCode || '';
    const existing = safe.canton || '';
    const r = result || {};
    return [
      `canton-gate id=${id}`,
      `country=${country}`,
      `postal=${postal}`,
      `locality="${locality}"`,
      `existing=${existing}`,
      `→ canton=${r.canton || ''}`,
      `confidence=${r.confidence || ''}`,
    ].join(' ');
  } catch {
    return 'canton-gate <trace-error>';
  }
}
