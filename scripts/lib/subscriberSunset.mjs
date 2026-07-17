/**
 * Newsletter inactivity sunset — pure classifier.
 *
 * Decides what to do with a newsletter subscriber who has received many sends
 * yet NEVER opened nor clicked. This is list hygiene: continuing to mail
 * never-engagers hurts sender reputation (open-rate / spam-rate are measured
 * per-domain), which degrades inbox placement for the engaged majority. Pruning
 * dead addresses is therefore a deliverability *gain*, and it is revenue-neutral
 * (a never-opener never visits the site, so never produced ad revenue).
 *
 * Graduated + reversible by design — never a hard cut:
 *   1. `winback`    — first action: send ONE re-engagement email, mark winback_sent_at.
 *   2. `sunset`     — after a grace window with still no open/click → status 'inactive'
 *                     (soft: excluded from sends but easily resubscribable).
 *   3. `reactivate` — an 'inactive' subscriber who has since opened/clicked → back to 'active'.
 *
 * `inactive` is a NEWSLETTER-channel soft state, NOT an address-level hard signal
 * (bounce/complaint/suppression). It lives in NEWSLETTER_EXCLUDED_STATUSES, never
 * in ADDRESS_SUPPRESSED_STATUSES — see services/emailSuppression.mjs.
 *
 * Thresholds are intentionally conservative (only conclamated zombies):
 * 120 days on the list AND ≥12 ignored sends with zero engagement.
 */

import { toMillis } from './firestoreTimestamp.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SUNSET_MIN_SENDS = 12;
export const SUNSET_MIN_AGE_DAYS = 120;
export const WINBACK_GRACE_DAYS = 14;

// Statuses we may transition FROM. We never touch unsubscribed / bounced /
// complained / suppressed (explicit or hard signals own those), and an empty /
// missing status is treated as mailable ('active'-equivalent).
const MAILABLE_STATUSES = new Set(['active', 'confirmed', '']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * Earliest "age" anchor for the subscriber: when they joined / first got mailed.
 * Falls back across the common field spellings.
 */
function firstSeenMillis(sub) {
  return (
    toMillis(sub?.created_at) ??
    toMillis(sub?.createdAt) ??
    toMillis(sub?.subscribed_at) ??
    toMillis(sub?.subscribedAt) ??
    toMillis(sub?.first_sent_at) ??
    toMillis(sub?.firstSentAt) ??
    null
  );
}

/**
 * @typedef {{ action: 'none'|'winback'|'sunset'|'reactivate', reason: string }} SunsetVerdict
 */

/**
 * Classify a newsletter subscriber for the sunset lifecycle.
 * Pure: no I/O, no Date.now() — caller passes `nowMs` for testability.
 *
 * @param {object} sub Firestore newsletter_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @returns {SunsetVerdict}
 */
export function classifySunset(sub, nowMs) {
  const status = norm(sub?.status);
  const engaged = num(sub?.open_count ?? sub?.openCount) > 0 || num(sub?.click_count ?? sub?.clickCount) > 0;

  // Already sunset: only ever resurrect on real engagement; otherwise leave be.
  if (status === 'inactive') {
    return engaged
      ? { action: 'reactivate', reason: 'inactive subscriber has since opened/clicked' }
      : { action: 'none', reason: 'inactive, still no engagement' };
  }

  // Never touch non-mailable states (unsubscribed / bounced / complained / suppressed).
  if (!MAILABLE_STATUSES.has(status)) {
    return { action: 'none', reason: `status '${status}' is not eligible` };
  }

  // Any engagement clears the path — and clears a stale winback flag upstream.
  if (engaged) return { action: 'none', reason: 'subscriber has engaged' };

  const sends = num(sub?.send_count ?? sub?.sendCount);
  const firstSeen = firstSeenMillis(sub);
  // No age anchor → we can't prove the subscriber has been on the list long
  // enough, so treat as too-young (ageDays 0) and never sunset. Conservative by
  // design: a missing date must not silently bypass the 120-day floor.
  const ageDays = firstSeen == null ? 0 : (nowMs - firstSeen) / DAY_MS;

  const isCandidate = sends >= SUNSET_MIN_SENDS && ageDays >= SUNSET_MIN_AGE_DAYS;
  if (!isCandidate) {
    return { action: 'none', reason: `below threshold (sends=${sends}, ageDays=${Math.floor(ageDays)})` };
  }

  const winbackAt = toMillis(sub?.winback_sent_at ?? sub?.winbackSentAt);
  if (winbackAt == null) {
    return { action: 'winback', reason: `${sends} ignored sends over ${Math.floor(ageDays)}d, no engagement` };
  }

  // Explicit re-consent: the win-back CTA hits ?action=resubscribe, whose handler
  // stamps `resubscribed_at` (status → 'confirmed'). A click is NOT necessarily
  // recorded as an ESP `click_count` (the win-back is sent click-tracking-free),
  // so honor the resubscribe timestamp directly — otherwise a user who clicked
  // "yes, keep me" would still be sunset at grace expiry. Provider-independent.
  const reengagedAt = toMillis(
    sub?.resubscribed_at ?? sub?.resubscribedAt ?? sub?.reactivated_at ?? sub?.reactivatedAt,
  );
  if (reengagedAt != null && reengagedAt >= winbackAt) {
    return { action: 'none', reason: 'resubscribed/reactivated after win-back — explicit stay' };
  }

  const graceDays = (nowMs - winbackAt) / DAY_MS;
  if (graceDays >= WINBACK_GRACE_DAYS) {
    return { action: 'sunset', reason: `no engagement ${Math.floor(graceDays)}d after win-back` };
  }

  return { action: 'none', reason: `within win-back grace (${Math.floor(graceDays)}d/${WINBACK_GRACE_DAYS}d)` };
}
