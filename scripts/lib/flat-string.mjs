/**
 * flat-string.mjs
 *
 * `flatString(s)` returns a value-identical string that owns its own
 * characters, holding no reference to whatever buffer it was derived from.
 *
 * Why this exists
 * ---------------
 * V8 does not copy characters for substrings: a regex capture group or a
 * `String.prototype.slice()` result of length ≥ 13 is a *SlicedString*, a
 * 3-word header pointing INTO the parent string. That is exactly the right
 * trade-off for a short-lived substring, and exactly the wrong one when the
 * substring outlives its parent inside a long-lived collection: the tiny path
 * `/articoli-frontaliere/tutti/page-7` keeps the whole 400 KB HTML document it
 * was scraped from alive for as long as it stays in the Map.
 *
 * The dist/ BFS audits scrape one href set per page and store the normalised
 * paths in a Map/Set that lives for the entire walk. Every page reached
 * therefore stayed resident, and the audits OOMed at the 8 GB heap limit after
 * ~900 s (issue #7419). Measured on a 200-page × 400 KB synthetic corpus:
 * 79.8 MB retained without flattening, 3.9 MB with — a 20× reduction that
 * scales with the corpus, because the retained bytes are the corpus.
 *
 * `Buffer.from(s, 'utf8').toString('utf8')` is used rather than a
 * `(' ' + s).slice(1)` style trick because it is an explicit round-trip
 * through a copy: no dependence on which shape V8 happens to pick for a cons
 * string. The cost is O(length of the *substring*), not of the parent.
 *
 * @param {string} s
 * @returns {string} a flat, parent-free copy (`''` and short strings are
 *   returned as-is: V8 never slices below `SlicedString::kMinLength`, so there
 *   is nothing to detach and the copy would be pure overhead).
 */
export function flatString(s) {
  if (typeof s !== 'string' || s.length < 13) return s;
  return Buffer.from(s, 'utf8').toString('utf8');
}
