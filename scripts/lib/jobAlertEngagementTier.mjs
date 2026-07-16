/**
 * Job-alert adaptive-frequency engagement tier — pure classifier (owner design
 * 2026-07-16). The engine decides send cadence by default; a subscriber's
 * alert only escapes this classifier when it carries a manual
 * `frequencyOverride: true` (user explicitly pinned daily/weekly from the UI,
 * or an operator backfill) — send-job-alerts.mjs consults this module only
 * for non-overridden alerts.
 *
 * Recency-based on the SAME `last_open_at`/`last_click_at` fields every ESP
 * webhook handler already writes on the top-level `job_alert_subscribers/
 * {email}` doc (verified across all 5 providers' applyJobAlertEvent-style
 * handlers in functions/src/newsletter*WebhookCore.js) — no new
 * sliding-window counters needed.
 *
 * Tier priority (highest engagement wins, independent of which is more
 * recent — a click within the lookback is always the strongest signal):
 *   'daily'  — clicked within JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS
 *   '36h'    — no recent click, but opened within the lookback
 *   'weekly' — neither opened nor clicked within the lookback (or never)
 *
 * Terminal stage stays scripts/lib/jobAlertSunset.mjs, unchanged and strictly
 * downstream: a subscriber only reaches sunset once the LIST-LEVEL
 * delivered-count/age thresholds fire there, regardless of tier here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS = 14;

export const JOB_ALERT_ENGAGEMENT_TIERS = Object.freeze({
  DAILY: 'daily',
  OPEN_36H: '36h',
  WEEKLY: 'weekly',
});

function toMillis(v) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * @typedef {{ tier: 'daily'|'36h'|'weekly', reason: string }} JobAlertEngagementVerdict
 */

/**
 * Classify the engine-managed cadence tier for a job-alert subscriber.
 * Pure: no I/O, no Date.now() — caller passes `nowMs` for testability.
 *
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @returns {JobAlertEngagementVerdict}
 */
export function classifyJobAlertEngagementTier(sub, nowMs) {
  const lastClick = toMillis(sub?.last_click_at ?? sub?.lastClickAt);
  const lastOpen = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);
  const lookbackMs = JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS * DAY_MS;

  if (lastClick != null && nowMs - lastClick <= lookbackMs) {
    return {
      tier: JOB_ALERT_ENGAGEMENT_TIERS.DAILY,
      reason: `clicked ${Math.floor((nowMs - lastClick) / DAY_MS)}d ago`,
    };
  }

  if (lastOpen != null && nowMs - lastOpen <= lookbackMs) {
    return {
      tier: JOB_ALERT_ENGAGEMENT_TIERS.OPEN_36H,
      reason: `opened ${Math.floor((nowMs - lastOpen) / DAY_MS)}d ago, no recent click`,
    };
  }

  return {
    tier: JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY,
    reason: lastOpen == null && lastClick == null
      ? 'never opened or clicked'
      : `last engagement beyond ${JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS}d lookback`,
  };
}

/**
 * Resolve the tier that should actually gate this alert's send cadence:
 * the engine tier, unless the alert has a sticky manual override, in which
 * case the user's pinned `frequency` wins verbatim (only 'daily'/'weekly'
 * are pinnable from the UI — there is no manual 36h option).
 *
 * @param {{ frequency?: string, frequencyOverride?: boolean }} alert
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @returns {JobAlertEngagementVerdict & { manual: boolean }}
 */
export function resolveEffectiveJobAlertTier(alert, sub, nowMs) {
  if (alert?.frequencyOverride === true) {
    const pinned = alert.frequency === 'daily' ? 'daily' : 'weekly';
    return { tier: pinned, reason: 'manual frequencyOverride pinned', manual: true };
  }
  return { ...classifyJobAlertEngagementTier(sub, nowMs), manual: false };
}
