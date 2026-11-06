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
 * Why the Buffer round-trip and not something prettier
 * ----------------------------------------------------
 * The "obvious" flatteners do not flatten. Measured (in
 * audit-duplicate-meta-description.mjs, which hit this same OOM first and
 * carried a private copy of this helper until issue #7419 made it shared) on
 * 40'000 samples taken out of ~10 KB parents:
 *
 *     desc.slice(0, 100)                    10'115 B/entry
 *     `${desc.slice(0, 100)}`               10'114 B/entry   ← no-op
 *     s.normalize() / s.repeat(1) / padEnd  ~10'100 B/entry  ← also no-ops
 *     Buffer.from(s,'utf8').toString()         131 B/entry
 *     s.split('').join('')                     130 B/entry
 *
 * A single-substitution template literal is optimised away, as are the other
 * candidates; only routing the bytes outside the JS heap and back builds a
 * fresh SeqString. Buffer is also the fastest of the two that work (120 ms vs
 * 405 ms per 40'000 on the same measurement). The cost is O(length of the
 * *substring*), not of the parent.
 *
 * The CPU side of that trade is bounded by
 * tests/seo/sitemap-loader-flatten-budget.test.ts, which measures the overhead
 * against the cost of the parse loop it rides on. It exists because the hot
 * callers flatten per-URL over the whole sitemap corpus, where a flattener of
 * a different order (`split('').join('')` is 2.88x the Buffer round-trip's
 * overhead ratio on that harness) would turn the OOM this helper prevents into
 * a timeout. Measured verdict for the worst caller,
 * scripts/validate-sitemap-pages.mjs: ~0.8 s on a 504-545 s gate.
 *
 * The round-trip is content-exact for every caller here: the parents were read
 * with utf8 encoding, so they cannot contain lone surrogates for the encoder to
 * replace.
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
