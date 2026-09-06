/**
 * scripts/lib/locale-map-diff.mjs
 *
 * Key-order-independent comparison of locale-keyed maps (`slugByLocale`,
 * `titleByLocale`, `descriptionByLocale`, …).
 *
 * Why this exists (follow-up di #7492): every call site that had to answer
 * "did this locale map change?" answered it with
 * `JSON.stringify(a) !== JSON.stringify(b)`, which is sensitive to KEY ORDER.
 * Two maps carrying the identical pairs in a different insertion order — the
 * normal outcome when one side is rebuilt with `{ ...old }` plus the missing
 * keys of the other, or when a slice was written by an older crawler that
 * emitted the locales in a different sequence — compare as different. In
 * `restoreExistingSlugIdentity` that made the `restored` counter and the slug
 * journal tell two contradictory stories about the same restore: the counter
 * incremented on the string mismatch while the per-locale loop, which compares
 * values field by field, found nothing to record. The counter is the only
 * measure that says whether the SEO redirects survived a crawl, so it must be
 * derived from the same comparison the journal is.
 *
 * Semantics are deliberately identical to the stringify comparison minus the
 * key-order sensitivity: a missing key and an explicit `undefined` are the
 * same thing, and values are compared strictly (no trimming, no coercion).
 */

/** @param {unknown} map */
function asMap(map) {
  return map && typeof map === 'object' && !Array.isArray(map) ? /** @type {Record<string, unknown>} */ (map) : {};
}

/**
 * Locale keys whose value differs between the two maps, sorted so callers
 * (journal entries, logs) get a deterministic order.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {string[]}
 */
export function diffLocaleKeys(left, right) {
  const a = asMap(left);
  const b = asMap(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

/**
 * True when both maps hold the same locale → value pairs, whatever the order
 * the keys were inserted in.
 *
 * @param {unknown} left
 * @param {unknown} right
 */
export function localeMapsEqual(left, right) {
  return diffLocaleKeys(left, right).length === 0;
}

/**
 * Stable identity key for a locale map: the same pairs always produce the same
 * string, whatever order the keys were inserted in. For the call sites that use
 * a serialised locale map as a fallback identity (no `slug`, no `id`) and then
 * match that key against an object of DIFFERENT provenance — an in-memory entry
 * against the same record re-read from an on-disk slice, say — where the key
 * order is whatever the last writer emitted, and a raw `JSON.stringify` makes
 * the two identities miss each other.
 *
 * @param {unknown} map
 */
export function localeMapKey(map) {
  const m = asMap(map);
  return JSON.stringify(Object.keys(m).sort().map((key) => [key, m[key]]));
}
