/**
 * Boundary-aware slug truncation.
 *
 * A plain `.slice(0, maxLength)` can chop a slug mid-token, producing
 * dead URLs like `...switzerland-genev` (cut off from `...switzerland-geneve`).
 * The chopped form is unrouted: SEO bridges and 301s key on the canonical
 * full slug, so the truncated variant becomes an orphan landing at the next
 * crawler run.
 *
 * This helper trims back to the last hyphen when the cut lands inside a token,
 * but only if doing so doesn't sacrifice more than ~25% of the cap (otherwise
 * we'd produce a uselessly short slug for single-huge-word inputs).
 *
 * @param {string} slug - the slugified input (lowercase, [a-z0-9-] only)
 * @param {number} maxLength - hard cap on the slug length
 * @returns {string} slug truncated to <= maxLength, with no partial trailing token
 */
export function truncateSlugAtWordBoundary(slug, maxLength) {
  if (!slug || slug.length <= maxLength) return slug || '';
  // If the boundary lands ON a hyphen (or end-of-string), no token is split.
  const nextChar = slug.charAt(maxLength);
  if (nextChar === '-' || nextChar === '') return slug.slice(0, maxLength);
  // Mid-token cut — trim back to the previous hyphen.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  // Only roll back if we keep at least 75% of the cap. Otherwise (e.g. single
  // huge word with no separators in range) accept the mid-word chop — it's
  // pathological data and a near-empty slug is worse.
  if (lastDash >= maxLength * 0.75) return cut.slice(0, lastDash);
  return cut;
}
