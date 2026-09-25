/**
 * cadenceCalendar.mjs — the arithmetic every engagement-driven cadence needs,
 * in one home (issue #5705).
 *
 * WHY IT IS ITS OWN FILE
 * ──────────────────────
 * Two channels now run a cadence engine: the daily brief
 * (scripts/lib/dailyBriefCadence.mjs, #5415) and the job alerts
 * (scripts/lib/jobAlertCadence.mjs, #5705). They classify different signals and
 * write different fields — that is why they are two engines and not one
 * parametrised module — but they answer "how many days since we last mailed
 * this person" identically, and they must keep answering it identically.
 *
 * These four names moved here verbatim from dailyBriefCadence.mjs, which
 * re-exports them so every existing importer keeps working: the same shim shape
 * that file already applies to EMAIL_SCANNER_IP_RANGES and to the whole
 * synthetic-click rule set. tests/daily-brief-cadence.test.ts passes unchanged,
 * which is the proof the move is neutral.
 *
 * CALENDAR DAYS, NOT 24-HOUR WINDOWS. This is the load-bearing choice, and it
 * is measured, not aesthetic: the job-alert cron is `33 0 * * *` and its own
 * workflow docblock records a dispatch delay of median 240 minutes, p90 471,
 * max 590. A millisecond gate against a ~10-hour jitter skips days at random —
 * it is why the "36h" gate this replaces behaved sometimes as 48h and sometimes
 * as 72h. Comparing UTC calendar days instead makes the due set a pure function
 * of (stored state, today), so a rerun is a no-op and a second cron slot cannot
 * make anybody newly due.
 */

import { toMillis } from './syntheticClicks.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of a timestamp, as YYYY-MM-DD. */
export function utcDayOf(value) {
  const ms = toMillis(value);
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

/** Whole UTC days between two YYYY-MM-DD dates (b − a). */
export function daysBetweenIso(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/**
 * Providers whose sends are invisible to us. Cloudflare has no webhook at all
 * ("no open/click", scripts/check-email-quotas.mjs), so a Cloudflare send that
 * draws no click proves nothing — counting it toward a demotion streak would
 * demote people for OUR blind spot, and counting it toward a decay counter
 * would retire them for it (issue #5415 §3.2d, #5705 §4.3).
 */
export const ENGAGEMENT_BLIND_PROVIDERS = Object.freeze(new Set(['cloudflare']));

/**
 * Expected daily volume for a tier distribution — what a dry-run prints so a
 * rollout decision is made against the cascade cap instead of a hope (#5415
 * §3.6). Keys are days-between-sends, values are how many recipients sit there.
 * @param {Record<number, number>} byTier recipients per tier
 */
export function estimateDailyVolume(byTier) {
  let total = 0;
  for (const [days, count] of Object.entries(byTier)) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += count / n;
  }
  return Math.round(total);
}
