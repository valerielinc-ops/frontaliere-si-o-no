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
 * A CLICK IS NOT A CLICK (#5767, and #5674 which this channel never got)
 * ─────────────────────────────────────────────────────────────────────
 * Until 2026-08-13 this file read `last_click_at` raw and had no `import` line
 * at all. The daily brief had grown a filter for what a click actually proves;
 * this channel — the one the LPD complaint was about — never consumed it. The
 * result was the worst sentence a cadence engine can produce: **clicking
 * "unsubscribe" in a job alert classified the recipient as engaged and promoted
 * them to the tier that sends the most.** Now every click goes through
 * scripts/lib/syntheticClicks.mjs first.
 *
 * Three decisions this file makes that the brief does not:
 *
 * 1. AN OPT-OUT CLICK DEMOTES, it is not merely ignored. If the most recent
 *    click we can read is the way out, the verdict is the SLOWEST tier,
 *    whatever the opens say. Ignoring it is not neutral here: somebody opens
 *    the mail in order to unsubscribe, so the accompanying open would hold them
 *    on a 36h cadence — the same complaint one notch quieter. A later genuine
 *    click is by definition more recent and restores the fast tier immediately,
 *    which is the same promotion-fast/demotion-slow hysteresis the brief
 *    documents. Cost of being wrong (a scanner clicked the unsubscribe link of
 *    a real reader): one week instead of 36h on a channel nobody asked for,
 *    undone by their next real click. Cost of the other error: the LPD letter
 *    we already have.
 *
 * 2. FAIL-CLOSED ON A CLICK WE CANNOT READ. `click_count` is a bare counter and
 *    `last_click_at` a bare instant; without a URL neither can tell a person
 *    from Safe Links. So a click with no readable URL (or no readable instant)
 *    NEVER reaches the fastest tier — the document falls to what its opens
 *    deserve, or to weekly. This diverges from the brief on purpose, and the
 *    reason is measured: on 2026-08-13, of 393 click events sampled from 40
 *    click-tier recipients here, ZERO carried `metadata.ip` and ZERO a
 *    user-agent (the job-alert branches of the webhook handlers write a poorer
 *    metadata than their newsletter twins in the same file). Two of the four
 *    synthetic-click rules are structurally inert on this channel, so the
 *    remaining evidence has to be treated as thin, not as proof.
 *
 * 3. THE EVENTS SUBCOLLECTION IS OPTIONAL, NOT ASSUMED. Callers that already
 *    hold the `events` docs pass them in `clickEvents` and get all four rules;
 *    callers that do not (send-job-alerts.mjs today — reading `events` for
 *    thousands of recipients is a cost decision tracked on #5705 §7) get the
 *    document-level path, which still catches the opt-out link because
 *    `last_clicked_url` is written beside `last_click_at` by all five handlers.
 *
 * Tier priority (highest engagement wins, independent of which is more
 * recent — a click within the lookback is always the strongest signal):
 *   'daily'           — a HUMAN click within JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS
 *   'every-other-day' — no such click, but opened within the lookback
 *                        (gate is 36h but cron runs once/day → effectively every other day)
 *   'weekly'          — neither, or the last click we can read was the way out
 *
 * SCOPE. The tier scale, the 7-day ceiling the owner chose on 2026-08-13 and
 * the decay of unengaged alerts are #5705, a PR on top of this one. This file
 * only changes what the click SIGNAL means, which is what every one of those
 * needs to be built on.
 *
 * Terminal stage stays scripts/lib/jobAlertSunset.mjs, unchanged and strictly
 * downstream: a subscriber only reaches sunset once the LIST-LEVEL
 * delivered-count/age thresholds fire there, regardless of tier here.
 */

import {
  EMAIL_SCANNER_IP_RANGES,
  classifyClickEvents,
  toMillis,
} from './syntheticClicks.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS = 14;

export const JOB_ALERT_ENGAGEMENT_TIERS = Object.freeze({
  DAILY: 'daily',
  OPEN_EVERY_OTHER_DAY: 'every-other-day',
  WEEKLY: 'weekly',
});

/**
 * What the click evidence on a document amounts to, once classified.
 *
 * `unverifiable` is the one that matters and the one that did not exist before:
 * "there was a click, and we cannot say anything about it". It is NOT the same
 * as `none` — a document with no click at all is simply quiet — and it must not
 * be treated as `human`, which is what reading `last_click_at` raw did.
 */
export const JOB_ALERT_CLICK_EVIDENCE = Object.freeze({
  HUMAN: 'human',
  OPT_OUT: 'opt-out',
  SYNTHETIC: 'synthetic',
  UNVERIFIABLE: 'unverifiable',
  NONE: 'none',
});

/** The click-ish fields, in both spellings. 458 docs carry only camelCase (#5673). */
function rawClickAtMs(sub) {
  return toMillis(sub?.last_click_at ?? sub?.lastClickAt);
}

function rawClickUrl(sub) {
  const url = sub?.last_clicked_url ?? sub?.lastClickedUrl;
  return typeof url === 'string' ? url : '';
}

function rawClickCount(sub) {
  const n = Number(sub?.click_count ?? sub?.clickCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @typedef {{ kind: string, atMs: number|null, reason: string }} JobAlertClickEvidence
 */

/**
 * What this subscriber's clicks actually prove.
 *
 * Two input paths, one rule set. With `clickEvents` the whole history is
 * classified; without them the document's own memory of its last click
 * (`last_click_at` + `last_clicked_url`) is run through the same classifier as
 * a one-event history — the two window rules cannot fire on one event, which is
 * correct, but the URL rules can, and the opt-out rule is the one that matters.
 *
 * The opt-out wins over a human click only when it is MORE RECENT: somebody who
 * asked to leave on Tuesday is not re-engaged by Monday's click, and somebody
 * who clicked a job on Tuesday is not leaving because of Monday's opt-out.
 *
 * @param {object} sub Firestore job_alert_subscribers root doc fields
 * @param {object} [options]
 * @param {Array<object>|null} [options.clickEvents] the `events` docs, if the caller has them
 * @param {ReadonlyArray<object|string>} [options.scannerRanges]
 * @returns {JobAlertClickEvidence}
 */
export function jobAlertClickEvidence(sub, { clickEvents = null, scannerRanges = EMAIL_SCANNER_IP_RANGES } = {}) {
  if (Array.isArray(clickEvents)) {
    if (clickEvents.length === 0) {
      return rawClickCount(sub) > 0
        ? { kind: JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE, atMs: null, reason: 'click_count > 0 with no click event to read' }
        : { kind: JOB_ALERT_CLICK_EVIDENCE.NONE, atMs: null, reason: 'never clicked' };
    }
    const verdict = classifyClickEvents(clickEvents, { scannerRanges });
    const { lastHumanClickAtMs, lastOptOutClickAtMs } = verdict;
    if (lastOptOutClickAtMs != null && (lastHumanClickAtMs == null || lastOptOutClickAtMs > lastHumanClickAtMs)) {
      return { kind: JOB_ALERT_CLICK_EVIDENCE.OPT_OUT, atMs: lastOptOutClickAtMs, reason: 'last readable click was the opt-out link' };
    }
    if (lastHumanClickAtMs != null) {
      return { kind: JOB_ALERT_CLICK_EVIDENCE.HUMAN, atMs: lastHumanClickAtMs, reason: 'human click in the events log' };
    }
    // Every event was synthetic, or none carried an instant we could read.
    const dated = verdict.verdicts.some((v) => v.atMs != null);
    return dated
      ? { kind: JOB_ALERT_CLICK_EVIDENCE.SYNTHETIC, atMs: null, reason: `every click was synthetic (${Object.keys(verdict.byReason).join(', ')})` }
      : { kind: JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE, atMs: null, reason: 'click events carry no readable instant' };
  }

  const atMs = rawClickAtMs(sub);
  if (atMs == null) {
    return rawClickCount(sub) > 0
      ? { kind: JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE, atMs: null, reason: 'click_count > 0 with no readable instant' }
      : { kind: JOB_ALERT_CLICK_EVIDENCE.NONE, atMs: null, reason: 'never clicked' };
  }
  const url = rawClickUrl(sub);
  if (url === '') {
    // Fail-closed: an instant with no URL cannot be told from a Safe Links hit.
    return { kind: JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE, atMs, reason: 'click with no readable url' };
  }
  const verdict = classifyClickEvents([{ at: atMs, url }], { scannerRanges });
  if (verdict.lastOptOutClickAtMs != null) {
    return { kind: JOB_ALERT_CLICK_EVIDENCE.OPT_OUT, atMs: verdict.lastOptOutClickAtMs, reason: 'last known click was the opt-out link' };
  }
  if (verdict.lastHumanClickAtMs != null) {
    return { kind: JOB_ALERT_CLICK_EVIDENCE.HUMAN, atMs: verdict.lastHumanClickAtMs, reason: 'last known click looks like a person' };
  }
  return {
    kind: JOB_ALERT_CLICK_EVIDENCE.SYNTHETIC,
    atMs: null,
    reason: `last known click was synthetic (${Object.keys(verdict.byReason).join(', ') || 'unclassified'})`,
  };
}

/**
 * @typedef {{ tier: 'daily'|'every-other-day'|'weekly', reason: string, clickEvidence: string }} JobAlertEngagementVerdict
 */

/**
 * Classify the engine-managed cadence tier for a job-alert subscriber.
 * Pure: no I/O, no Date.now() — caller passes `nowMs` for testability.
 *
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @param {object} [options] forwarded to {@link jobAlertClickEvidence}
 * @returns {JobAlertEngagementVerdict}
 */
export function classifyJobAlertEngagementTier(sub, nowMs, options = {}) {
  const lookbackMs = JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS * DAY_MS;
  const withinLookback = (ms) => ms != null && nowMs - ms <= lookbackMs;
  const evidence = jobAlertClickEvidence(sub, options);
  const lastOpen = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);

  if (evidence.kind === JOB_ALERT_CLICK_EVIDENCE.HUMAN && withinLookback(evidence.atMs)) {
    return {
      tier: JOB_ALERT_ENGAGEMENT_TIERS.DAILY,
      reason: `clicked ${Math.floor((nowMs - evidence.atMs) / DAY_MS)}d ago`,
      clickEvidence: evidence.kind,
    };
  }

  // The gesture that asks for less must never buy more, and here it buys less.
  if (evidence.kind === JOB_ALERT_CLICK_EVIDENCE.OPT_OUT && withinLookback(evidence.atMs)) {
    return {
      tier: JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY,
      reason: `asked to leave ${Math.floor((nowMs - evidence.atMs) / DAY_MS)}d ago (${evidence.reason})`,
      clickEvidence: evidence.kind,
    };
  }

  if (withinLookback(lastOpen)) {
    return {
      tier: JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY,
      reason: `opened ${Math.floor((nowMs - lastOpen) / DAY_MS)}d ago, no recent human click`
        + (evidence.kind === JOB_ALERT_CLICK_EVIDENCE.NONE ? '' : ` (${evidence.reason})`),
      clickEvidence: evidence.kind,
    };
  }

  return {
    tier: JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY,
    reason: lastOpen == null && evidence.kind === JOB_ALERT_CLICK_EVIDENCE.NONE
      ? 'never opened or clicked'
      : `no engagement inside the ${JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS}d lookback (${evidence.reason})`,
    clickEvidence: evidence.kind,
  };
}

/**
 * Resolve the tier that should actually gate this alert's send cadence:
 * the engine tier, unless the alert has a sticky manual override, in which
 * case the user's pinned `frequency` wins verbatim (only 'daily'/'weekly'
 * are pinnable from the UI — there is no manual every-other-day option).
 *
 * The pin still wins over an opt-out click, and deliberately so: it is the only
 * field on these documents that carries an explicit act of the person about
 * their own frequency (#5705 D4 leaves it with the owner). It is also a
 * different question — the pin says how often, the opt-out says whether — and
 * a completed opt-out deactivates the alert before this code ever sees it.
 *
 * @param {{ frequency?: string, frequencyOverride?: boolean }} alert
 * @param {object} sub Firestore job_alert_subscribers doc fields
 * @param {number} nowMs current time in ms
 * @param {object} [options] forwarded to {@link jobAlertClickEvidence}
 * @returns {JobAlertEngagementVerdict & { manual: boolean }}
 */
export function resolveEffectiveJobAlertTier(alert, sub, nowMs, options = {}) {
  if (alert?.frequencyOverride === true) {
    const pinned = alert.frequency === 'daily' ? 'daily' : 'weekly';
    return { tier: pinned, reason: 'manual frequencyOverride pinned', clickEvidence: 'not-consulted', manual: true };
  }
  return { ...classifyJobAlertEngagementTier(sub, nowMs, options), manual: false };
}
