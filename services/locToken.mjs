// Whole-token location matching, shared by every geo filter/ranking path so the
// "substring keeps an out-of-area job" antipattern (#2630) can't drift back in
// (jobAlertMatching hard filter + newsletter-content ranking/pre-filter both
// used bare `.includes()`).
//
// `needle` must appear in `haystack` bounded by string start/end or a non-letter
// character on both sides, so the location "bern" no longer matches a job in
// "bernex"/"berna". Unicode-aware (`\p{L}`) so accented city names delimit
// correctly; multi-word locations ("san gallo") match as a contiguous phrase;
// hyphen/comma-delimited cities still match ("lugano" in "Lugano-Paradiso").
//
// @param {string} haystack lowercased joined job-location text
// @param {string} needle   lowercased alert/profile/subscriber location token
// @returns {boolean}
export function locTokenHit(haystack, needle) {
  if (!needle) return false;
  const esc = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, 'u').test(String(haystack));
}
