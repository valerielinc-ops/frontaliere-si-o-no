/**
 * Compare two `expiredAt` values chronologically. Mirrors the sign
 * convention of `String.prototype.localeCompare` (negative: `a` earlier,
 * positive: `a` later, 0: equal or both unparseable) but parses each value
 * as a date first, so records whose `expiredAt` isn't strictly
 * ISO-comparable as a string (legacy format, different length/precision)
 * still sort by actual recency instead of lexicographic order. A value that
 * parses is treated as later than one that doesn't.
 */
export function compareExpiredAt(a, b) {
  const aTime = Date.parse(a || '');
  const bTime = Date.parse(b || '');
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid) return aTime - bTime;
  if (aValid !== bValid) return aValid ? 1 : -1;
  return String(a || '').localeCompare(String(b || ''));
}
