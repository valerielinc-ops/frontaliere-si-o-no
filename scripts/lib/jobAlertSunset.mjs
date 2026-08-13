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
 *   3. `reprobe`    — an 'inactive' subscriber who stayed silent long enough
 *                     that `reactivate`'s engagement evidence can never arrive
 *                     (no sender ever writes to job_alert_subscribers while
 *                     inactive — worse than the newsletter case, there isn't
 *                     even an accidental exit) → one-time, capped return to
 *                     mailable. See scripts/lib/reprobeGuard.mjs (issue #5559).
 *
 * DECAY WINS OVER REPROBE (issue #5705 §5.4). A cadence decay
 * (`cadence_state: 'decayed'`, scripts/lib/jobAlertCadence.mjs) is terminal by
 * design and its only exit is an affirmative act by the person on the site.
 * The re-probe above says the opposite — "mail them once more and see whether
 * they react" — and on a channel nobody asked for that is the exact gesture the
 * complaint was about. So a caller that knows the subscriber's alerts have
 * decayed passes `cadenceDecayed: true` and the re-probe is withheld; the two
 * mechanisms disagree, and the quieter one wins.
 */

import { isReprobeDue, REPROBE_AFTER_INACTIVE_DAYS, REPROBE_MAX_ATTEMPTS } from './reprobeGuard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const JOB_ALERT_SUNSET_MIN_DELIVERED = 12;
export const JOB_ALERT_SUNSET_MIN_AGE_DAYS = 120;
export { REPROBE_AFTER_INACTIVE_DAYS, REPROBE_MAX_ATTEMPTS };

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
 * @typedef {{ action: 'none'|'sunset'|'reactivate'|'reprobe', reason: string }} JobAlertSunsetVerdict
 */

/**
 * One-time, capped reprobe before giving up on a still-silent inactive doc —
 * mirrors scripts/lib/subscriberSunset.mjs's reprobeOrNone (issue #5559).
 * @param {object} sub
 * @param {number} nowMs
 * @param {string} noneReason
 * @returns {JobAlertSunsetVerdict}
 */
function reprobeOrNone(sub, nowMs, noneReason, cadenceDecayed = false) {
  // A decayed cadence is terminal (#5705 §5.4): re-probing it would undo, from
  // a different module, the one decision this repo makes about a channel that
  // was never requested.
  if (cadenceDecayed) {
    return { action: 'none', reason: `${noneReason} — re-probe withheld: cadence decayed (terminal)` };
  }
  // sunset_reprobe_count / sunset_reprobed_at are deliberately their own field
  // names, NOT the bare reprobe_count/reprobed_at that
  // scripts/lib/suppressionDecay.mjs already owns on this same collection for
  // its unrelated bounced/suppressed → active recovery mechanism (its own cap,
  // MAX_REPROBE_ATTEMPTS=2). See scripts/lib/subscriberSunset.mjs's twin
  // comment for the collision this avoids.
  const attempts = num(sub?.sunset_reprobe_count ?? sub?.sunsetReprobeCount);
  const anchorMs = toMillis(sub?.sunset_reprobed_at ?? sub?.sunsetReprobedAt) ?? toMillis(sub?.inactive_at);
  if (isReprobeDue({ attempts, anchorMs, nowMs })) {
    return {
      action: 'reprobe',
      reason: `${noneReason} — ${REPROBE_AFTER_INACTIVE_DAYS}d silent, one-time re-probe (attempt ${attempts + 1}/${REPROBE_MAX_ATTEMPTS})`,
    };
  }
  return { action: 'none', reason: noneReason };
}

/**
 * Classify a job-alert subscriber for the sunset lifecycle.
 * Pure: no I/O, no Date.now() — caller passes `nowMs` for testability.
 *
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @param {object} [options]
 * @param {boolean} [options.cadenceDecayed] this subscriber's alerts have
 *        reached the terminal cadence state (scripts/lib/jobAlertCadence.mjs).
 *        Suppresses the re-probe only — see the header.
 * @returns {JobAlertSunsetVerdict}
 */
export function classifyJobAlertSunset(sub, nowMs, { cadenceDecayed = false } = {}) {
  const status = norm(sub?.status);
  const engaged = num(sub?.open_count ?? sub?.openCount) > 0 || num(sub?.click_count ?? sub?.clickCount) > 0;

  // Already sunset: only ever resurrect on real engagement; otherwise leave be.
  if (status === 'inactive') {
    return engaged
      ? { action: 'reactivate', reason: 'inactive job-alert subscriber has since opened/clicked' }
      : reprobeOrNone(sub, nowMs, 'inactive, still no engagement', cadenceDecayed);
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
