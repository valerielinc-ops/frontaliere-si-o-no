// scripts/lib/scheduler/slugSimilarity.mjs
//
// Cross-pool deduplication via Jaccard similarity over alphanumeric
// tokens (lowercased, length >= 3). Used by the discovery pool to drop
// near-duplicates of headlines already present in the proven pool.
//
// Two tokens are considered "equivalent" when they share a >=6 char
// common prefix — this folds Italian inflection variants (frontaliere /
// frontalieri / frontalieri) into the same bucket, which is required by
// the Phase 3 acceptance test ('frontaliere ticino' vs
// 'frontalieri in ticino' must clear the 0.7 threshold).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.5

const MIN_TOKEN_LEN = 3;
const PREFIX_FOLD_LEN = 6;
const TOKEN_RE = /[a-z0-9]+/g;

export const SLUG_SIMILARITY_THRESHOLD = 0.7;

/**
 * Tokenize a string for similarity comparison: lowercase, strip diacritics,
 * keep alphanumeric runs of length >= 3.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeForSimilarity(input) {
  if (typeof input !== 'string' || input.length === 0) return [];
  const normalized = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const tokens = normalized.match(TOKEN_RE) || [];
  return tokens.filter((t) => t.length >= MIN_TOKEN_LEN);
}

/**
 * Fold a token to its canonical key for Jaccard set comparison. Tokens
 * with length >= PREFIX_FOLD_LEN collapse to their first PREFIX_FOLD_LEN
 * chars; shorter tokens are kept as-is.
 *
 * @param {string} token
 * @returns {string}
 */
function foldToken(token) {
  if (token.length <= PREFIX_FOLD_LEN) return token;
  return token.slice(0, PREFIX_FOLD_LEN);
}

/**
 * Jaccard similarity between two strings, computed over folded
 * alphanumeric token sets. Returns 0 when either input has no tokens.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenizeForSimilarity(a).map(foldToken));
  const setB = new Set(tokenizeForSimilarity(b).map(foldToken));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * True when `candidate` is similar enough to ANY headline in `existing`
 * to be considered a near-duplicate.
 *
 * @param {string} candidate
 * @param {string[]} existing
 * @param {number} [threshold=SLUG_SIMILARITY_THRESHOLD]
 * @returns {boolean}
 */
export function isNearDuplicate(candidate, existing, threshold = SLUG_SIMILARITY_THRESHOLD) {
  if (!candidate || !Array.isArray(existing) || existing.length === 0) return false;
  for (const other of existing) {
    if (jaccardSimilarity(candidate, other) >= threshold) return true;
  }
  return false;
}
