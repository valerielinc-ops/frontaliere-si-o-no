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

// Some Swiss places are stored under a different local-language name/code by
// crawlers than the alert uses. Keep aliases deliberately explicit: this covers
// the GR names emitted by the corpus, the "Coira / Chur" choice shown by
// JobAlertForm, and the common Ticino/Tessin canton labels and code.
const LOCATION_TOKEN_ALIAS_GROUPS = Object.freeze([
  Object.freeze(['coira', 'chur', 'coire', 'cuira']),
  Object.freeze(['ticino', 'tessin', 'ti', 'canton ticino', 'cantone ticino', 'canton tessin', 'kanton tessin']),
]);
const LOCATION_TOKEN_ALIASES = new Map(
  LOCATION_TOKEN_ALIAS_GROUPS.flatMap((group) => group.map((name) => [name, group])),
);

// JobAlertForm offers these cities as individual choices. Historical alerts
// can contain a pair in one value (for example "Lugano Mendrisio"); expand
// only when every component is a known city so arbitrary multi-word areas keep
// their whole-token semantics.
const COMPOSABLE_CITY_TOKENS = new Set([
  'lugano', 'mendrisio', 'bellinzona', 'locarno', 'chiasso',
  ...LOCATION_TOKEN_ALIAS_GROUPS[0],
]);

/**
 * Return the normalized spelling variants for a location token.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function locationTokenVariants(value) {
  const normalized = normalizeLocToken(value);
  if (!normalized) return [];
  const aliases = LOCATION_TOKEN_ALIASES.get(normalized);
  if (aliases) return aliases;

  // A city followed by its canton is still a city constraint. Only the
  // known Ticino choices qualify; returning the canton here would widen a
  // Lugano alert to the whole canton. Unknown/conflicting labels stay whole.
  const suffix = normalized.match(/^(.+?) (ticino|tessin|ti)$/);
  if (suffix && COMPOSABLE_CITY_TOKENS.has(suffix[1])
    && !LOCATION_TOKEN_ALIAS_GROUPS[0].includes(suffix[1])) return [suffix[1]];

  const parts = normalized.split(' ');
  if (parts.length > 1 && parts.every((part) => COMPOSABLE_CITY_TOKENS.has(part))) {
    return Array.from(new Set(parts.flatMap((part) => LOCATION_TOKEN_ALIASES.get(part) || [part])));
  }
  return [normalized];
}

// @param {string} haystack lowercased joined job-location text
// @param {string} needle   lowercased alert/profile/subscriber location token
// @returns {boolean}
export function locTokenHit(haystack, needle) {
  const h = normalizeLocToken(haystack);
  if (!h) return false;
  // After normalization both sides are single-space-delimited ASCII tokens, so a
  // space-padded boundary test is a correct word-boundary match and still finds
  // multi-word phrases ("san gallo") and hyphen-joined cities ("lugano paradiso").
  const paddedHaystack = ` ${h} `;
  return locationTokenVariants(needle).some((variant) => paddedHaystack.includes(` ${variant} `));
}
