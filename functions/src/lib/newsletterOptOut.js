/**
 * newsletterOptOut.js — PINNED MIRROR of services/newsletterOptOut.mjs.
 *
 * The Cloud Functions bundle cannot import anything outside `functions/`, so
 * this is a deliberate copy rather than a second, independently-invented rule —
 * the same arrangement `normalizeCompanyAlertKey` has with
 * build-plugins/shared/companyProfileSlug.mjs. Read the canonical file for the
 * reasoning (why the stamp is append-only since #5711, and why the supersession
 * signal is `resubscribed_at` and never `confirmed_at`).
 *
 * Parity is asserted, not assumed: tests/newsletter-optout-supersession.test.ts
 * runs the SAME fixture table through both modules and fails on any divergence.
 * Change one, change the other in the same PR.
 */

export const OPT_OUT_STAMP_FIELDS = Object.freeze(['unsubscribed_at', 'unsubscribedAt']);
export const RE_OPT_IN_STAMP_FIELDS = Object.freeze(['resubscribed_at', 'resubscribedAt']);

/** @param {unknown} value @returns {number|null} */
export function toEpochMillis(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'object') {
      if (typeof value.toMillis === 'function') {
        const ms = value.toMillis();
        return Number.isFinite(ms) ? ms : null;
      }
      if (typeof value.toDate === 'function') {
        const ms = value.toDate()?.getTime?.();
        return Number.isFinite(ms) ? ms : null;
      }
      if (typeof value.seconds === 'number') {
        const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
        return value.seconds * 1000 + Math.floor(nanos / 1e6);
      }
      if (typeof value._seconds === 'number') {
        const nanos = typeof value._nanoseconds === 'number' ? value._nanoseconds : 0;
        return value._seconds * 1000 + Math.floor(nanos / 1e6);
      }
    }
  } catch { /* unreadable value → null, i.e. "not proven newer" */ }
  return null;
}

function firstMillis(sub, fields) {
  for (const field of fields) {
    const ms = toEpochMillis(sub?.[field]);
    if (ms != null) return ms;
  }
  return null;
}

export function newsletterOptOutMillis(sub) {
  return firstMillis(sub, OPT_OUT_STAMP_FIELDS);
}

export function newsletterReOptInMillis(sub) {
  return firstMillis(sub, RE_OPT_IN_STAMP_FIELDS);
}

export function hasNewsletterOptOutStamp(sub) {
  if (!sub) return false;
  return OPT_OUT_STAMP_FIELDS.some((f) => sub[f] != null);
}

export function isNewsletterOptOutSuperseded(sub) {
  const optOut = newsletterOptOutMillis(sub);
  if (optOut == null) return false;
  const reOptIn = newsletterReOptInMillis(sub);
  if (reOptIn == null) return false;
  if (String(sub?.status || '').trim().toLowerCase() === 'unsubscribed') return false;
  return reOptIn > optOut;
}

export function isNewsletterOptOutBinding(sub) {
  if (!sub) return false;
  const recorded = String(sub.status || '').trim().toLowerCase() === 'unsubscribed'
    || hasNewsletterOptOutStamp(sub);
  if (!recorded) return false;
  return !isNewsletterOptOutSuperseded(sub);
}
