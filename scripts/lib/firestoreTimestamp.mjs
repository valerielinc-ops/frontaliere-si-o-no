/**
 * Normalize any of the Firestore timestamp shapes we encounter across the
 * newsletter classifiers/reports (a live `Timestamp` from firebase-admin, a
 * plain `{_seconds}` object from a REST/emulator read, or a JS `Date`/ISO
 * string) into epoch milliseconds.
 *
 * Extracted so the same coercion logic can't drift between
 * scripts/lib/subscriberSunset.mjs, scripts/lib/dormantWinback.mjs and
 * scripts/lib/newsletter-ab-data.mjs — all three read raw Firestore doc
 * fields and previously each carried their own copy.
 *
 * @param {*} v
 * @returns {number|null}
 */
export function toMillis(v) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
