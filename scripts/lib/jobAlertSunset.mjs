/**
 * Job-alert inactivity sunset — pure classifier (issue #2852 item 1, follow-up
 * to PR #2836's newsletter-only `scripts/lib/subscriberSunset.mjs`).
 *
 * Job alerts share the sending domain with the newsletter, so a zombie
 * job-alert mailing (many deliveries, zero opens/clicks, ever) raises the
 * per-domain spam-rate and degrades inbox placement for engaged newsletter
 * subscribers too — see #2852 item 1 rationale. This is list hygiene on the
 * `job_alert_subscribers/{email}` CHANNEL, deliberately separate from:
 *   - the per-alert `active:false` opt-out (a search-config toggle), and
 *   - the address-level hard-suppression from #2831 (bounce/complaint/provider
 *     list — see services/emailSuppression.mjs ADDRESS_SUPPRESSED_STATUSES).
 * Neither of those is touched here.
 *
 * Engagement-tracking prerequisite (verified against all 5 ESP webhook cores'
 * `persistJobAlert*Event` handlers before writing this classifier): every
 * provider (Mailgun/Maileroo/Mailjet/Mailtrap/Resend) increments
 * `open_count`/`click_count`/`delivered_count` on the TOP-LEVEL
 * `job_alert_subscribers/{email}` doc for open/click/delivered events — so an
 * analog to the newsletter's `open_count`/`click_count` genuinely exists and is
 * reliable. `delivered_count` (not `send_count`) is used as the "ignored
 * sends" signal below because `scripts/send-job-alerts.mjs` never writes a
 * send-time counter itself, and only Resend's job-alert branch ever sets
 * `last_sent_at`/`send_count` — `delivered_count` is the one counter every
 * provider increments consistently. (Only Resend's handler additionally
 * writes a genuine `alert_deliveries/{alertId}` subcollection record; the
 * other four write to an `events` subcollection instead — a separate,
 * non-blocking sibling-pattern gap noted for a future PR, not required here
 * since the classifier only needs the top-level counters.)
 *
 * Two states only (no win-back email stage): the newsletter's graduated
 * winback → sunset flow requires translated re-engagement email copy, which
 * is out of scope for what issue #2852 item 1 actually asks for (a classifier
 * + thresholds + a channel-level `inactive` state). Going straight from
 * "candidate" to `sunset` still fully delivers the stated funnel-impact
 * (stop mailing zombies) without inventing new copy:
 *   1. `sunset`     — ≥ JOB_ALERT_SUNSET_MIN_DELIVERED ignored deliveries over
 *                     ≥ JOB_ALERT_SUNSET_MIN_AGE_DAYS with zero engagement →
 *                     status 'inactive' (soft, reversible).
 *   2. `reactivate` — an 'inactive' subscriber who has since opened/clicked →
 *                     back to 'active'.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const JOB_ALERT_SUNSET_MIN_DELIVERED = 12;
export const JOB_ALERT_SUNSET_MIN_AGE_DAYS = 120;

// Statuses we may transition FROM. We never touch bounced / complained /
// suppressed (hard, cross-channel signals owned by #2831's suppression list —
// see services/emailSuppression.mjs). An empty/missing status is mailable.
const MAILABLE_STATUSES = new Set(['active', '']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toMillis(v) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * Earliest "age" anchor for the job-alert subscriber doc.
 * scripts/migrate-job-alerts-to-subscribers.mjs stamps `createdAt` at doc
 * creation; fall back across common spellings for resilience.
 */
function firstSeenMillis(sub) {
  return (
    toMillis(sub?.createdAt) ??
    toMillis(sub?.created_at) ??
    toMillis(sub?.first_delivered_at) ??
    toMillis(sub?.firstDeliveredAt) ??
    null
  );
}

/**
 * @typedef {{ action: 'none'|'sunset'|'reactivate', reason: string }} JobAlertSunsetVerdict
 */

/**
 * Classify a job-alert subscriber for the sunset lifecycle.
 * Pure: no I/O, no Date.now() — caller passes `nowMs` for testability.
 *
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @returns {JobAlertSunsetVerdict}
 */
export function classifyJobAlertSunset(sub, nowMs) {
  const status = norm(sub?.status);
  const engaged = num(sub?.open_count ?? sub?.openCount) > 0 || num(sub?.click_count ?? sub?.clickCount) > 0;

  // Already sunset: only ever resurrect on real engagement; otherwise leave be.
  if (status === 'inactive') {
    return engaged
      ? { action: 'reactivate', reason: 'inactive job-alert subscriber has since opened/clicked' }
      : { action: 'none', reason: 'inactive, still no engagement' };
  }

  // Never touch hard, cross-channel signals (bounce/complaint/suppression).
  if (!MAILABLE_STATUSES.has(status)) {
    return { action: 'none', reason: `status '${status}' is not eligible` };
  }

  // Any engagement clears the path.
  if (engaged) return { action: 'none', reason: 'subscriber has engaged' };

  const delivered = num(sub?.delivered_count ?? sub?.deliveredCount);
  const firstSeen = firstSeenMillis(sub);
  // No age anchor → can't prove enough time has passed, so never sunset.
  // Conservative by design, same as the newsletter classifier.
  const ageDays = firstSeen == null ? 0 : (nowMs - firstSeen) / DAY_MS;

  const isCandidate = delivered >= JOB_ALERT_SUNSET_MIN_DELIVERED && ageDays >= JOB_ALERT_SUNSET_MIN_AGE_DAYS;
  if (!isCandidate) {
    return { action: 'none', reason: `below threshold (delivered=${delivered}, ageDays=${Math.floor(ageDays)})` };
  }

  return { action: 'sunset', reason: `${delivered} ignored deliveries over ${Math.floor(ageDays)}d, no engagement` };
}
