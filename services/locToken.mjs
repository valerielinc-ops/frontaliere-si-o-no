// Whole-token location matching, shared by every geo filter/ranking path so the
// "substring keeps an out-of-area job" antipattern (#2630) can't drift back in
// (jobAlertMatching hard filter + newsletter-content ranking/pre-filter both
// used bare `.includes()`).
//
// `needle` must appear in `haystack` bounded by string start/end or a non-letter
// character on both sides, so the location "bern" no longer matches a job in
// "bernex"/"berna". Multi-word locations ("san gallo") match as a contiguous
// phrase; hyphen/comma-delimited cities still match ("lugano" in
// "Lugano-Paradiso").
//
// Both sides are run through `normalizeLocToken` first so the .mjs path folds
// diacritics + collapses whitespace/hyphens exactly like the .ts path
// `isLocationMatch` (which goes through `normalizeSearchText`). Without this the
// two funnels drift: "Zürich" would not match "zurich", and "san-gallo" /
// "san  gallo" (double space) would not match "san gallo" — the same false-
// negative class #2630 closed for substrings (#2713 follow-up, #2727 item 2).

/**
 * Fold a location string to a comparable form: lowercase, strip diacritics
 * (NFD → drop combining marks), and collapse every run of non-alphanumeric
 * characters (whitespace, hyphens, commas, …) to a single ASCII space, trimmed.
 * Mirrors the token shape produced by textUtils.normalizeSearchText so the
 * `.mjs` geo match and the `.ts` `isLocationMatch` stay aligned.
 *
 * @param {string} value
 * @returns {string} normalized, single-space-delimited ASCII tokens
 */
export function normalizeLocToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// @param {string} haystack lowercased joined job-location text
// @param {string} needle   lowercased alert/profile/subscriber location token
// @returns {boolean}
export function locTokenHit(haystack, needle) {
  const n = normalizeLocToken(needle);
  if (!n) return false;
  const h = normalizeLocToken(haystack);
  if (!h) return false;
  // After normalization both sides are single-space-delimited ASCII tokens, so a
  // space-padded boundary test is a correct word-boundary match and still finds
  // multi-word phrases ("san gallo") and hyphen-joined cities ("lugano paradiso").
  return ` ${h} `.includes(` ${n} `);
}
