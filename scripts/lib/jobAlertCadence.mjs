/**
 * jobAlertCadence.mjs — per-recipient send cadence and terminal decay for the
 * job-alert channel (issue #5705, owner's plan of 2026-08-13 and his ceiling
 * decision of the same day).
 *
 * THE CADENCE IS NOT THE CONSENT. Read this before changing anything here.
 * ──────────────────────────────────────────────────────────────────────────
 * 6.306 of the alerts this module governs were created by a backfill from the
 * newsletter list. Nobody asked for them. Sending them less often makes them
 * less invasive; it does not make them consented, and no field this module
 * writes is evidence that anybody agreed to anything. "Should they receive
 * this at all?" is an open question that belongs to the owner (#5705), and
 * nothing here answers it or should be quoted as answering it.
 *
 * WHAT THIS MODULE DOES
 * ─────────────────────
 *  1. Turns the engagement verdict of scripts/lib/jobAlertEngagementTier.mjs
 *     into an interval in CALENDAR DAYS on the [1, 3, 7] scale the owner chose.
 *  2. Applies JOB_ALERT_CADENCE_CEILING_DAYS = 7 on top of it: the effective
 *     interval is max(tier, ceiling). Engagement can move a recipient BELOW the
 *     ceiling's frequency, never above it.
 *  3. Decides "is this alert due today?" as a pure function of stored state and
 *     the calendar day.
 *  4. Advances the stored state after a send, and stamps a TERMINAL, PRESERVED
 *     `cadence_state: 'decayed'` once an alert has taken
 *     JOB_ALERT_DECAY_AFTER_SLOW_SENDS sends on the slowest tier without a
 *     single signal. EVERY alert, since the owner's decision of 2026-08-14 —
 *     see decayStampAfterSend, which used to require the backfill.
 *  5. Brings a decayed alert back when the person returns to the site, subject
 *     to the seven refusals the owner approved — see
 *     reactivationAfterReturnVisit, and functions/src/lib/returnVisit.js for the
 *     four of them the page load itself decides.
 *  6. Refuses to serve an alert twice in one day, or to stack a send on top of
 *     one that is scheduled and has not left yet — see alreadyServedToday. That
 *     is what makes a SECOND daily cron slot safe, and it is deliberately in the
 *     state rather than in the spacing of the two crons: this repo's cron slots
 *     slip by a measured median of 240 minutes and up to 590, so two slots that
 *     are "far enough apart" are only far enough apart on a good day.
 *
 * THE CEILING, AND WHY IT SWALLOWS THE SCALE (owner, 2026-08-13)
 * ─────────────────────────────────────────────────────────────
 * With the ceiling at 7 the whole [1, 3, 7] table collapses to 7 for every
 * engine-managed alert. That is the decision, not a bug, and the tiers are not
 * thereby useless: they are what feeds the demotion streak and the decay
 * counter, and they are what will differentiate again the day the ceiling is
 * raised. Every function here takes `ceilingDays` as an argument so both
 * behaviours are exercised by tests and the lever is one value, not a rewrite.
 *
 * The reasoning behind the ceiling is the daily brief's `consentCeilingDays`
 * (#5679) applied to a channel whose accepted formula does not name it at all:
 * a formula that never mentions job adverts names no periodicity for them
 * either, so the prudent reading is the slowest one we run anywhere. The
 * measurement of engagement cannot lift it — "engagement is a measurement, and
 * a measurement is never permission".
 *
 * THE ONE EXEMPTION: `frequencyOverride: true`.
 * Those alerts carry the only explicit act of the person about their own
 * frequency (a choice in the preference centre or a one-tap preset,
 * services/jobAlertService.ts). Honouring it is the same precedent the brief
 * applies to a pinned frequency, and capping it would silently overrule the
 * only party the consent exists to protect. Measured on 2026-08-13: 245 active
 * alerts carry the pin, of which 14 are backfilled — the owner's note said "14",
 * which is that backfilled slice, while the predicate he chose is channel-wide.
 *
 * DAYS, NOT MILLISECONDS
 * ──────────────────────
 * Intervals are UTC calendar days (scripts/lib/cadenceCalendar.mjs), never ms
 * windows. The cron is `33 0 * * *` with a measured dispatch delay of median
 * 240 min / max 590; a millisecond gate against that jitter skips days at
 * random, which is exactly how the "36h" gate this replaces behaved sometimes
 * as 48h and sometimes as 72h. A consequence to state plainly rather than hide:
 * with ONE cron slot per day the owner's "one every 24-36 hours" is not
 * obtainable as a band. Tier 1 means "one calendar day", i.e. 24h ± the
 * dispatch delay. A true 36h band needs a second slot, as the brief has (#5705
 * D3, still the owner's).
 *
 * PURE. No I/O, no `Date.now()`: `nowMs` and `todayIso` are arguments, the same
 * discipline as scripts/lib/dailyBriefCadence.mjs and
 * scripts/lib/jobAlertEngagementTier.mjs, and what makes a rerun, a dry-run and
 * a test compute the same answer.
 *
 * WHERE STATE LIVES
 * ─────────────────
 * The cadence is per RECIPIENT and lives in `ja_cadence_*` fields on the root
 * `job_alert_subscribers/{email}` document, next to the counters all five ESP
 * webhooks already write there. It must NEVER be `last_sent_at`: that field is
 * the 36-hour mutex between the newsletter and this channel (send-newsletter.mjs
 * reads it), and writing it for another reason would starve both. This module
 * reads it as a fallback anchor and never writes it.
 *
 * The terminal decay is per ALERT and lives in `cadence_*` fields on
 * `job_alert_subscribers/{email}/alerts/{alertId}`, because "we gave up on this
 * search" is a statement about that alert.
 */

import { toMillis } from './syntheticClicks.mjs';
import { isCrossChannelStop, isJobAlertExcluded } from '../../functions/src/lib/emailSuppression.js';
// Re-exported, not just imported: a caller that acts on a refusal needs the
// whole vocabulary, and the four verdicts the page load decides are half of it.
// Two import lines for one decision is how a caller ends up comparing against a
// string literal instead of a constant.
import {
  RETURN_VISIT_VERDICTS,
  classifyReturnVisit,
  readReturnVisitStamp,
} from '../../functions/src/lib/returnVisit.js';

export { RETURN_VISIT_VERDICTS };
import { ENGAGEMENT_BLIND_PROVIDERS, daysBetweenIso, estimateDailyVolume, utcDayOf } from './cadenceCalendar.mjs';
import {
  JOB_ALERT_CLICK_EVIDENCE,
  JOB_ALERT_ENGAGEMENT_TIERS,
  classifyJobAlertEngagementTier,
  jobAlertClickEvidence,
} from './jobAlertEngagementTier.mjs';

/** Days between sends, ordered from most to least frequent (owner's table). */
export const JOB_ALERT_CADENCE_TIERS = Object.freeze([1, 3, 7]);

/**
 * The ceiling nobody's engagement can lift. `null` disables it and restores the
 * bare owner table — the lever, kept as an argument everywhere so raising it is
 * one value and not a rewrite.
 */
export const JOB_ALERT_CADENCE_CEILING_DAYS = 7;

/** Consecutive signal-free sends before an alert drops one tier. */
export const JOB_ALERT_DEMOTION_STREAK = 3;

/**
 * N — sends on the SLOWEST tier without a signal before a backfilled alert
 * decays. Counted in SENDS, never in weeks: somebody we never mailed (cascade
 * quota exhausted, 36h newsletter cooldown, a bounced address) cannot decay on
 * a calendar we did not honour.
 *
 * Why 8: the slowest tier produces at most ~13 sends across the entire life of
 * the oldest documents here (none is over 90 days old), so 8 is a real trial
 * and not a token one; and 8 sends ≈ 56 days lands well before the 120-day
 * threshold of scripts/lib/jobAlertSunset.mjs, so the two mechanisms do not
 * race — decay fires first and sunset becomes a no-op on these documents.
 */
export const JOB_ALERT_DECAY_AFTER_SLOW_SENDS = 8;

/**
 * The alert-level cadence lifecycle. TERMINAL AND PRESERVED, not a deletion.
 *
 * `active` is deliberately NOT touched by decay. On these documents `active` is
 * solely the soft-delete/opt-out flag (send-job-alerts.mjs, and
 * functions/src/newsletterSubscriptionManagement.js): flipping it here would
 * make an alert we retired on our own indistinguishable from one the person
 * switched off, destroying the very record the terminal state exists to keep —
 * "we stopped sending by ourselves, after N attempts, without anybody asking".
 * Same principle the owner chose for the `expired` state of #5692.
 */
export const JOB_ALERT_CADENCE_STATES = Object.freeze({
  ACTIVE: 'active',
  DECAYED: 'decayed',
});

/**
 * The engagement verdict of jobAlertEngagementTier.mjs, in days.
 *
 * The verdict strings are kept as-is rather than renamed to numbers because
 * they are already persisted in `last_engagement_tier` on thousands of
 * production documents and the monitoring report compares against them. Note
 * that `every-other-day` now means THREE days, per the owner's table — the name
 * records where the tier came from, the number is what governs.
 */
export const JOB_ALERT_TIER_DAYS = Object.freeze({
  [JOB_ALERT_ENGAGEMENT_TIERS.DAILY]: 1,
  [JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY]: 3,
  [JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]: 7,
});

/** What the preference centre can pin, in days. There is no manual middle tier. */
export const JOB_ALERT_MANUAL_FREQUENCY_DAYS = Object.freeze({ daily: 1, weekly: 7 });

const SLOWEST_TIER = JOB_ALERT_CADENCE_TIERS[JOB_ALERT_CADENCE_TIERS.length - 1];
const FASTEST_TIER = JOB_ALERT_CADENCE_TIERS[0];

export { estimateDailyVolume };

// ── tier arithmetic ────────────────────────────────────────────────────────

/** Snap any stored number onto the nearest tier at or below it, floor 1 day. */
export function normalizeCadenceTier(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return null;
  if (n <= FASTEST_TIER) return FASTEST_TIER;
  for (let i = JOB_ALERT_CADENCE_TIERS.length - 1; i >= 0; i--) {
    if (n >= JOB_ALERT_CADENCE_TIERS[i]) return JOB_ALERT_CADENCE_TIERS[i];
  }
  return FASTEST_TIER;
}

const tierIndex = (days) => Math.max(0, JOB_ALERT_CADENCE_TIERS.indexOf(normalizeCadenceTier(days)));
const demote = (days) => JOB_ALERT_CADENCE_TIERS[Math.min(JOB_ALERT_CADENCE_TIERS.length - 1, tierIndex(days) + 1)];

// ── which alerts these rules were written for ──────────────────────────────

/**
 * Was this alert created by the newsletter backfill rather than by a person?
 *
 * Two spellings because both exist in production: the batch and both Cloud
 * Function triggers write the fixed document id `backfill-newsletter`, and the
 * payload additionally carries `backfilled_from`
 * (scripts/backfill-jobalerts-from-newsletter.mjs). A field, not a heuristic —
 * measured 2026-08-13 on the digest population: 6.306 backfilled against 529
 * created by a person.
 *
 * THIS NO LONGER DECIDES WHO DECAYS (owner, 2026-08-14). Until that day the
 * answer to D6 was "only the backfilled ones", and `decayStampAfterSend` gated
 * on this predicate. The owner has since decided that decay applies to EVERY
 * alert, including the ones people created themselves. The predicate stays
 * because provenance is still worth reading — the report separates the two
 * populations, and `backfilled_from` is the field that says which alerts nobody
 * asked for — but it is no longer a decay precondition.
 */
export function isBackfilledAlert(alert) {
  return alert?.id === 'backfill-newsletter'
    || alert?.backfilled_from != null
    || alert?.backfilledFrom != null;
}

/** Does this alert carry the person's own explicit choice of frequency? */
export function isManuallyPinned(alert) {
  return alert?.frequencyOverride === true;
}

/**
 * The cadence lifecycle state of an alert, FAIL-CLOSED.
 *
 * Anything that is not literally `active` (or absent, which is how every
 * document born before this engine reads) is `unknown` and will not be sent.
 * On a channel nobody asked for, an unreadable state is worth silence.
 */
export function cadenceStateOf(alert) {
  const raw = alert?.cadence_state ?? alert?.cadenceState;
  if (raw == null || raw === '') return JOB_ALERT_CADENCE_STATES.ACTIVE;
  const norm = String(raw).trim().toLowerCase();
  if (norm === JOB_ALERT_CADENCE_STATES.ACTIVE) return JOB_ALERT_CADENCE_STATES.ACTIVE;
  if (norm === JOB_ALERT_CADENCE_STATES.DECAYED) return JOB_ALERT_CADENCE_STATES.DECAYED;
  return 'unknown';
}

/** Has this alert reached the terminal state? */
export function isDecayed(alert) {
  return cadenceStateOf(alert) === JOB_ALERT_CADENCE_STATES.DECAYED;
}

/** May the sender still select this alert at all? */
export function isCadenceSendable(alert) {
  return cadenceStateOf(alert) === JOB_ALERT_CADENCE_STATES.ACTIVE;
}

// ── seeding and the engine tier ────────────────────────────────────────────

/**
 * The tier a recipient starts on, read off the engagement history the ESP
 * webhooks have been writing for months — through the SAME classifier the
 * sender consults, so the seed and the running engine cannot disagree and the
 * seeded distribution is exactly the live one.
 *
 * "Human click" is scripts/lib/syntheticClicks.mjs by way of that classifier
 * (#5674, #5767): a corporate scanner, an automation agent, a burst of targets
 * in three seconds and a click on the unsubscribe link are none of them a
 * reader, and a click we cannot read at all never reaches the fastest tier.
 *
 * @param {object} sub `job_alert_subscribers/{email}` fields
 * @param {number} nowMs
 * @param {object} [options] forwarded to the classifier (`clickEvents`, …)
 * @returns {{ tierDays: number, tier: string, reason: string, clickEvidence: string }}
 */
export function seedJobAlertTier(sub, nowMs, options = {}) {
  const verdict = classifyJobAlertEngagementTier(sub || {}, nowMs, options);
  return {
    tierDays: JOB_ALERT_TIER_DAYS[verdict.tier] ?? SLOWEST_TIER,
    tier: verdict.tier,
    reason: verdict.reason,
    clickEvidence: verdict.clickEvidence,
  };
}

/**
 * The engine tier governing this recipient today: the stored one once seeded,
 * otherwise a fresh read of the history.
 * @returns {{ tierDays: number, tier: string, source: 'state'|'seed', reason: string }}
 */
export function engineTierFor(sub, nowMs, options = {}) {
  const stored = normalizeCadenceTier(sub?.ja_cadence_tier);
  if (stored != null) {
    return {
      tierDays: stored,
      tier: tierLabelFor(stored),
      source: 'state',
      reason: `engine tier ${stored}d`,
    };
  }
  const seed = seedJobAlertTier(sub, nowMs, options);
  return { tierDays: seed.tierDays, tier: seed.tier, source: 'seed', reason: seed.reason };
}

/** The verdict label a tier in days corresponds to (inverse of JOB_ALERT_TIER_DAYS). */
export function tierLabelFor(tierDays) {
  const normalized = normalizeCadenceTier(tierDays) ?? SLOWEST_TIER;
  for (const [label, days] of Object.entries(JOB_ALERT_TIER_DAYS)) {
    if (days === normalized) return label;
  }
  return JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY;
}

// ── the effective interval ─────────────────────────────────────────────────

/**
 * How many days must pass between two sends for this alert, and why.
 *
 * Order, and it is the whole policy:
 *   1. a frequency the PERSON pinned  → verbatim, ceiling and all. The only way
 *      past the ceiling, because it is the only field carrying their own act.
 *   2. the engine tier                → then raised to the ceiling.
 *      max(tier, ceiling): engagement may slow a recipient down, never speed
 *      them up past what we are prepared to defend.
 *
 * The engine tier underneath stays uncapped on purpose (`nextJobAlertCadenceState`
 * keeps tracking it), so raising the ceiling later changes what people receive
 * without a data migration and without having overwritten anything.
 *
 * @returns {{ intervalDays: number, tier: string, tierDays: number,
 *             source: 'override'|'state'|'seed', manual: boolean,
 *             ceilingDays: number|null, ceilingApplied: boolean, reason: string }}
 */
export function resolveJobAlertCadence(alert, sub, nowMs, {
  ceilingDays = JOB_ALERT_CADENCE_CEILING_DAYS,
  ...options
} = {}) {
  if (isManuallyPinned(alert)) {
    const pinned = alert?.frequency === 'daily'
      ? JOB_ALERT_MANUAL_FREQUENCY_DAYS.daily
      : JOB_ALERT_MANUAL_FREQUENCY_DAYS.weekly;
    return {
      intervalDays: pinned,
      tier: alert?.frequency === 'daily' ? JOB_ALERT_ENGAGEMENT_TIERS.DAILY : JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY,
      tierDays: pinned,
      source: 'override',
      manual: true,
      ceilingDays,
      ceilingApplied: false,
      reason: `manual frequencyOverride pinned (${pinned}d); exempt from the ceiling`,
    };
  }

  const engine = engineTierFor(sub, nowMs, options);
  const ceiling = Number.isFinite(Number(ceilingDays)) && Number(ceilingDays) > 0 ? Number(ceilingDays) : null;
  const capped = ceiling != null && engine.tierDays < ceiling;
  return {
    intervalDays: capped ? ceiling : engine.tierDays,
    tier: engine.tier,
    tierDays: engine.tierDays,
    source: engine.source,
    manual: false,
    ceilingDays: ceiling,
    ceilingApplied: capped,
    reason: capped
      ? `${engine.reason}; held at ${ceiling}d by the channel ceiling`
      : engine.reason,
  };
}

// ── two send slots a day, and one email (owner, 2026-08-14) ────────────────

/**
 * Everything the sender may have written when it served this alert, in the two
 * spellings production carries. `ja_cadence_*` is written by this repo in
 * snake_case only — but `scripts/lib/subscriberFromFirestoreRow.mjs` and the
 * report scripts hand callers camelCase projections, and a reader that knows one
 * spelling answers "never sent" for the other. Here that answer is fail-OPEN:
 * it is the one direction in which a missing stamp produces a SECOND email.
 */
function servedStamps({ alert, sub, manual }) {
  return {
    alertLastSent: alert?.lastMatchedAt ?? alert?.last_matched_at ?? null,
    alertScheduledFor: alert?.cadence_scheduled_for ?? alert?.cadenceScheduledFor ?? null,
    recipientLastSent: manual
      ? null
      : (sub?.ja_cadence_last_sent_at ?? sub?.jaCadenceLastSentAt ?? null),
    recipientScheduledFor: manual
      ? null
      : (sub?.ja_cadence_scheduled_for ?? sub?.jaCadenceScheduledFor
        ?? sub?.last_scheduled_for ?? sub?.lastScheduledFor ?? null),
  };
}

/**
 * Has this alert ALREADY been served for `todayIso` — including by a message
 * that is scheduled and has not left yet?
 *
 * THE OWNER ASKED FOR TWO SEND SLOTS A DAY, AND THIS IS THE WHOLE DEFENCE.
 * ──────────────────────────────────────────────────────────────────────────
 * The protection against a double send cannot live in the spacing of the two
 * cron slots. `.github/workflows/send-job-alerts.yml` records a measured
 * dispatch delay of median 240 minutes and max 590 for the 00:33 slot: two slots
 * placed hours apart drift into each other on a bad morning, and "they are far
 * enough apart" stops being true exactly on the day it matters. Two processes
 * over one piece of state make each other harmless IN THE STATE — the second
 * slot has to look at an alert the first one served and see "not due", whatever
 * the clock says. That is this function, and it is asked BEFORE any interval
 * arithmetic so it cannot be undone by a tier, a ceiling or a pin.
 *
 * THE SCHEDULED-BUT-NOT-SENT CASE, which the owner named specifically.
 * The sender does not always hand a message to the ESP for immediate delivery:
 * `computeScheduledSendAt` (scripts/lib/send-schedule.mjs) aims it at the
 * recipient's preferred hour, TODAY if that hour is still ahead and TOMORROW if
 * it has passed. The docblock of that function reasons about double sends and
 * concludes "there's no double-send risk" — resting, in as many words, on "the
 * newsletter/job-alert cron itself runs once daily". A second slot retires that
 * premise. So a message whose scheduled instant is still in the FUTURE counts as
 * already due: not only for the rest of today, but until it has actually gone
 * out, because until then a second one would land on top of it.
 *
 * Both clocks are read, per-ALERT and per-RECIPIENT, and the per-recipient one
 * is skipped for a manually pinned alert for the same reason the interval gate
 * skips it: the pin is the person's own act about their own frequency and lives
 * on its own clock. A pinned alert is still protected — by its own alert-level
 * stamp, which is unconditional.
 *
 * @returns {{ served: boolean, reason: string|null }}
 */
export function alreadyServedToday({ alert, sub, todayIso, nowMs, manual = isManuallyPinned(alert) }) {
  const stamps = servedStamps({ alert, sub, manual });

  for (const [which, value] of [['alert', stamps.alertLastSent], ['recipient', stamps.recipientLastSent]]) {
    if (value == null) continue;
    if (utcDayOf(value) === todayIso) {
      return { served: true, reason: `already served today on the ${which} clock` };
    }
  }

  for (const [which, value] of [['alert', stamps.alertScheduledFor], ['recipient', stamps.recipientScheduledFor]]) {
    if (value == null) continue;
    const atMs = toMillis(value);
    if (atMs == null) {
      // A scheduling stamp we cannot read is not proof that nothing is in
      // flight. Silence costs one email; the other answer costs two.
      return { served: true, reason: `an unreadable ${which} schedule stamp — treated as a send in flight` };
    }
    if (Number.isFinite(nowMs) && atMs > nowMs) {
      return { served: true, reason: `a ${which} send is scheduled for ${new Date(atMs).toISOString()} and has not left yet` };
    }
    if (utcDayOf(atMs) === todayIso) {
      return { served: true, reason: `a ${which} send was scheduled for today` };
    }
  }

  return { served: false, reason: null };
}

// ── the send decision ──────────────────────────────────────────────────────

/**
 * Is this alert due today?
 *
 * Pure function of (alert, subscriber, todayIso) — which is what makes a rerun
 * a no-op and absorbs the cron's 240-minute median dispatch delay.
 *
 * Four gates, all of which must pass:
 *   - the alert's lifecycle state is `active` (fail-closed: see cadenceStateOf);
 *   - nothing has served it today and nothing is in flight for it
 *     (`alreadyServedToday` — the two-slot guard, asked FIRST of the three that
 *     follow so no interval, ceiling or pin can talk over it);
 *   - the alert itself has waited its interval, measured from `lastMatchedAt`,
 *     the per-alert stamp the sender already writes;
 *   - the RECIPIENT has waited it too, measured from `ja_cadence_last_sent_at`.
 *     Somebody with three alerts must not receive three emails a week where a
 *     person with one receives one. Measured 2026-08-13: 6.835 active digest alerts
 *     over 6.332 distinct addresses, so this is not hypothetical.
 *
 * The per-recipient gate is consulted, and written, ONLY for engine-managed
 * alerts. A pinned daily alert must not be starved by an engine alert's stamp,
 * and must not starve one in return: the two live on separate clocks by design.
 *
 * @returns {{ due: boolean, decayed: boolean, reason: string } & ReturnType<typeof resolveJobAlertCadence>}
 */
export function isJobAlertDueToday({ alert, sub, todayIso, nowMs, ...options }) {
  const state = cadenceStateOf(alert);
  const cadence = resolveJobAlertCadence(alert, sub, nowMs, options);

  if (state !== JOB_ALERT_CADENCE_STATES.ACTIVE) {
    return {
      ...cadence,
      due: false,
      decayed: state === JOB_ALERT_CADENCE_STATES.DECAYED,
      reason: state === JOB_ALERT_CADENCE_STATES.DECAYED
        ? `cadence_state 'decayed' — terminal, only an affirmative act on the site reopens it`
        : `cadence_state '${String(alert?.cadence_state ?? alert?.cadenceState)}' is not readable — not sending`,
    };
  }

  // The two-slot guard, before the interval arithmetic. A second run on the
  // same day sees a served alert as not due even if the interval says otherwise
  // — and an interval is only ever ≥ 1 day today, which is precisely the kind of
  // implicit protection this repo has watched break: it holds because of an
  // arithmetic coincidence, not because anybody stated it.
  const served = alreadyServedToday({ alert, sub, todayIso, nowMs, manual: cadence.manual });
  if (served.served) {
    return { ...cadence, due: false, decayed: false, reason: `${cadence.reason}; ${served.reason}` };
  }

  const gates = [
    ['alert', utcDayOf(alert?.lastMatchedAt ?? alert?.last_matched_at)],
    ...(cadence.manual
      ? []
      : [['recipient', utcDayOf(sub?.ja_cadence_last_sent_at ?? sub?.jaCadenceLastSentAt)]]),
  ];

  let waited = null;
  for (const [which, lastIso] of gates) {
    if (!lastIso) continue; // never sent on this clock — nothing to respect
    const elapsed = daysBetweenIso(lastIso, todayIso);
    if (elapsed == null || elapsed < cadence.intervalDays) {
      // Fail-closed on an unreadable stamp too: silence costs an email, the
      // other error costs the thing the LPD letter was about.
      return {
        ...cadence,
        due: false,
        decayed: false,
        reason: `${cadence.reason}; ${elapsed == null ? 'unreadable' : `${elapsed}d`} since the last ${which} send, interval ${cadence.intervalDays}d`,
      };
    }
    waited = waited == null ? elapsed : Math.min(waited, elapsed);
  }

  return {
    ...cadence,
    due: true,
    decayed: false,
    reason: waited == null
      ? `${cadence.reason}; never sent`
      : `${cadence.reason}; ${waited}d since the last send, interval ${cadence.intervalDays}d`,
  };
}

// ── reading the signal since the last send ─────────────────────────────────

/**
 * The instant this recipient's cadence last produced a send.
 *
 * Falls back to `last_sent_at` — the field §5b of the sender has been writing
 * for months — so the first run of this engine does not treat every recipient
 * as never-mailed and reset everybody's history.
 */
function lastCadenceSendMs(sub) {
  return toMillis(sub?.ja_cadence_last_sent_at ?? sub?.jaCadenceLastSentAt)
    ?? toMillis(sub?.last_sent_at ?? sub?.lastSentAt)
    ?? null;
}

/**
 * Did a PERSON click since the last send? Promotion is immediate, so this is
 * the one place a single synthetic click would buy a whole tier — which is
 * precisely how a corporate scanner walked recipients up to the daily tier one
 * send at a time (#5674). It therefore goes through the click classifier, and
 * an opt-out click is not engagement at all.
 */
export function engagedSinceLastJobAlertSend(sub, options = {}) {
  const lastSent = lastCadenceSendMs(sub);
  if (lastSent == null) return false; // nothing sent yet — nothing to react to
  const evidence = jobAlertClickEvidence(sub || {}, options);
  // Only a HUMAN verdict counts. `ja_cadence_last_human_click_at` is consulted
  // for the INSTANT and never as a second opinion on the verdict: it is an
  // older precomputation, and preferring it over a fresher opt-out or a click
  // we cannot read would be the fail-open direction on exactly the question
  // #5674 is about.
  if (evidence.kind !== JOB_ALERT_CLICK_EVIDENCE.HUMAN) return false;
  const clickMs = evidence.atMs ?? toMillis(sub?.ja_cadence_last_human_click_at);
  return clickMs != null && clickMs > lastSent;
}

/**
 * Did they open since the last send? The weak signal: Apple Mail Privacy
 * Protection prefetches images, so an open is worth a tier of 3, never 1.
 */
export function openedSinceLastJobAlertSend(sub) {
  const lastSent = lastCadenceSendMs(sub);
  if (lastSent == null) return false;
  const open = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);
  return open != null && open > lastSent;
}

// ── advancing the state ────────────────────────────────────────────────────

/**
 * The `ja_cadence_*` fields to write on the root document after a send.
 *
 * PROMOTION IS IMMEDIATE, TO THE TIER THE SIGNAL EARNS — a deliberate
 * divergence from the brief, which moves one step per event. The owner's table
 * assigns a tier to a behaviour, so:
 *   - a human click            → tier 1, streak and decay counter reset;
 *   - an open with no click    → tier 3 if we were slower, otherwise HELD.
 *     Never 1: the worst case of a prefetched open is then one email every
 *     three days instead of one a week, never one a day.
 *
 * DEMOTION IS SLOW: three consecutive signal-free sends move one tier down,
 * floor 7. That asymmetry is the hysteresis — somebody who goes quiet for a
 * week is not punished for it, somebody who comes back is served at once.
 *
 * WHAT DOES NOT COUNT AS SILENCE, and why each one:
 *   - the first send ever (there was nothing to react to);
 *   - a send carried by a provider with no webhook (Cloudflare): it could not
 *     have reported anything, so counting it would demote and eventually retire
 *     people for OUR blind spot.
 *
 * `ja_cadence_weekly_sends` — the decay counter — advances only while the tier
 * is already the slowest. That is what makes N=8 mean "eight weekly sends into
 * silence" and not "eight sends" regardless of pace, and it is the arithmetic
 * the owner's plan sized 8 against.
 *
 * @param {object} args
 * @param {object} args.sub current root-doc fields
 * @param {boolean} args.engaged a human click since the last send
 * @param {boolean} [args.opened] an open since the last send
 * `ja_cadence_scheduled_for` is the instant the cascade actually aimed the
 * message at, or null when it went out immediately. It is written on EVERY send,
 * null included — a stale future stamp left over from a previous run would hold
 * the recipient silent forever, which is the one way this fail-closed field can
 * do harm. It is what `alreadyServedToday` reads to keep the second slot of the
 * day from stacking a message on top of one that has not left yet.
 *
 * @param {string} args.sentAtIso ISO timestamp of the send being recorded
 * @param {string|null} [args.provider] the cascade provider that carried it
 * @param {string|null} [args.scheduledFor] ISO instant the send was aimed at
 */
export function nextJobAlertCadenceState({ sub, engaged, opened = false, sentAtIso, provider = null, scheduledFor = null }) {
  const sentAtMs = Date.parse(sentAtIso) || 0;
  const current = normalizeCadenceTier(sub?.ja_cadence_tier)
    ?? normalizeCadenceTier(seedJobAlertTier(sub, sentAtMs).tierDays)
    ?? SLOWEST_TIER;
  const previousProvider = sub?.ja_cadence_last_send_provider ?? null;
  const previousStreak = Number(sub?.ja_cadence_sends_since_engagement) || 0;
  const previousSlowSends = Number(sub?.ja_cadence_weekly_sends) || 0;
  const hadPreviousSend = lastCadenceSendMs(sub) != null;

  let tier = current;
  let streak = previousStreak;
  let slowSends = previousSlowSends;

  if (engaged) {
    tier = FASTEST_TIER;
    streak = 0;
    slowSends = 0;
  } else if (opened) {
    tier = current === SLOWEST_TIER ? JOB_ALERT_TIER_DAYS[JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY] : current;
    streak = 0;
    slowSends = 0;
  } else if (previousProvider && ENGAGEMENT_BLIND_PROVIDERS.has(previousProvider)) {
    // The previous send could not have reported anything. Neither promote,
    // nor demote, nor advance the decay counter.
  } else if (hadPreviousSend) {
    streak = previousStreak + 1;
    if (current === SLOWEST_TIER) slowSends = previousSlowSends + 1;
    if (streak >= JOB_ALERT_DEMOTION_STREAK) {
      tier = demote(current);
      streak = 0;
    }
  }

  return {
    ja_cadence_tier: tier,
    ja_cadence_last_sent_at: sentAtIso,
    ja_cadence_sends_since_engagement: streak,
    ja_cadence_weekly_sends: slowSends,
    ja_cadence_last_send_provider: provider ?? null,
    ja_cadence_scheduled_for: scheduledFor ?? null,
    ...(tier !== current ? { ja_cadence_tier_updated_at: sentAtIso } : {}),
  };
}

/**
 * The terminal stamp to write on the ALERT document, or `null` when this send
 * does not retire it.
 *
 * WHO DECAYS: EVERYBODY (owner, 2026-08-14, superseding D6).
 * ─────────────────────────────────────────────────────────
 * Until that decision this function began with `if (!isBackfilledAlert(alert))
 * return null` and only retired the 6.306 alerts the newsletter backfill
 * created. The owner extended it to every alert, the ones people created
 * themselves included. The reasoning that made the asymmetry defensible ran out:
 * decay is not a punishment and not a deletion, it is us noticing that eight
 * consecutive weekly sends drew no signal of any kind. That observation is
 * exactly as true of an alert somebody set up in March and forgot as it is of
 * one nobody ever asked for, and the person who created it keeps the two things
 * the asymmetry was protecting — `active` untouched, so the alert is still
 * theirs and still listed, and a one-click way back through the preference
 * centre. What changes is that we stop mailing into silence.
 *
 * Preconditions, each of which is a decision and not a detail:
 *   - it is not manually pinned. THE ONE EXEMPTION, and the reason the D6 change
 *     above does not swallow it: `frequencyOverride: true` is an explicit act of
 *     the person about their own frequency (measured 2026-08-13: 254 alerts,
 *     239 of them with no `backfilled_from` at all, and 178 further alerts carry
 *     `frequencyOverride: false` — a field people demonstrably use). Retiring an
 *     alert whose frequency somebody chose by hand would overrule the only party
 *     the consent exists to protect;
 *   - it is not already decayed (the stamp records the moment we gave up, and
 *     rewriting it would move the evidence);
 *   - the post-send decay counter has reached N.
 *
 * NOTHING IS DELETED and `active` is NOT touched. `keywords`, `locations`,
 * `backfilled_from` and every counter stay exactly as they are; a decayed alert
 * simply stops being selected. There is deliberately no re-probe: "let us mail
 * them again and see if they react" is the very thing the complaint was about
 * on a channel nobody asked for. The only exit is an affirmative act on the
 * site, which writes a real consent (#5705 §5.4, a deliberate divergence from
 * the re-probe of scripts/lib/jobAlertSunset.mjs).
 */
/**
 * The addresses whose EVERY active alert has reached the terminal state.
 *
 * Why "every" and not "any": a re-probe (scripts/lib/jobAlertSunset.mjs) lifts
 * the CHANNEL-level `inactive` status, so it unblocks all of a person's alerts
 * at once. Somebody holding one decayed backfilled alert and one they created
 * themselves should still be re-probed — the live alert is the reason. Somebody
 * whose every alert is decayed should not, for two independent reasons that
 * point the same way: it is the "mail them once more and see if they react"
 * this channel's decay exists to refuse, and it would be futile anyway, because
 * the cadence gate would filter every one of their alerts while the re-probe
 * budget burned down.
 *
 * @param {Iterable<{email?: string, cadence_state?: string}>} alerts active alert docs
 * @returns {Set<string>} lowercased addresses
 */
export function recipientsWithAllAlertsDecayed(alerts) {
  const seen = new Map();
  for (const alert of alerts || []) {
    const email = String(alert?.email || '').toLowerCase();
    if (!email) continue;
    const decayed = isDecayed(alert);
    seen.set(email, (seen.get(email) ?? true) && decayed);
  }
  const out = new Set();
  for (const [email, allDecayed] of seen) if (allDecayed) out.add(email);
  return out;
}

export function decayStampAfterSend({ alert, nextState, sentAtIso, decayAfter = JOB_ALERT_DECAY_AFTER_SLOW_SENDS }) {
  if (isManuallyPinned(alert)) return null;
  if (!isCadenceSendable(alert)) return null;
  const sends = Number(nextState?.ja_cadence_weekly_sends) || 0;
  if (sends < decayAfter) return null;
  return {
    cadence_state: JOB_ALERT_CADENCE_STATES.DECAYED,
    cadence_decayed_at: sentAtIso,
    cadence_decay_reason: `no human signal in ${decayAfter} weekly sends`,
    cadence_sends_at_decay: sends,
  };
}

// ── coming back (owner, 2026-08-14) ────────────────────────────────────────

/**
 * Why a decayed alert did NOT come back on this pass. `OK` is the only value
 * that writes anything; every other one is a documented refusal, and the four
 * that the page load itself decides come through unchanged from
 * `RETURN_VISIT_VERDICTS` so a log line names one rule and not two.
 */
export const JOB_ALERT_REACTIVATION_BLOCKS = Object.freeze({
  OK: 'ok',
  NOT_DECAYED: 'not-decayed',
  SWITCHED_OFF: 'switched-off-by-the-person',
  CHANNEL_OPT_OUT: 'channel-opt-out',
  SUPPRESSED: 'address-suppressed',
  UNIDENTIFIED: 'visit-not-bound-to-this-person',
  STALE_VISIT: 'visit-predates-the-decay',
  ALREADY_CONSUMED: 'visit-already-consumed',
});

/** The trimmed identity of an alert or a subscriber document, or ''. */
const ownerUidOf = (doc) => String(doc?.userId ?? doc?.user_id ?? '').trim();

/**
 * Does this return visit bring a decayed alert back to life?
 *
 * THE DECISION, AND THE OBJECTION THE OWNER ANSWERED (2026-08-14)
 * ──────────────────────────────────────────────────────────────
 * A decayed alert reactivates BY ITSELF when the person comes back to the site.
 * The objection was put to the owner before he chose: this is an inference. We
 * deduce a wish to receive email from a behaviour — opening a web page — that
 * is not about email at all, on a channel where 6.306 of the alerts were never
 * requested in the first place. He chose the automatic behaviour, and asked in
 * the same breath that the inference not be drawn where it is obviously wrong.
 * The seven cases below are his list. Nothing here is a judgement call added on
 * top of it.
 *
 * WHY THE DECISION IS TAKEN HERE, AND NOT IN THE BROWSER OR IN A TRIGGER
 * ─────────────────────────────────────────────────────────────────────
 * The page load records a FACT ("a session was seen"); this function takes the
 * DECISION, and the sender calls it. Three reasons, in order of weight:
 *
 *  1. `firestore.rules` grants `allow write: if true` on
 *     `job_alert_subscribers/{email}` — the grant services/jobAlertService.ts
 *     needs to create the parent document. Anything the browser writes there is
 *     therefore a CLAIM, not a fact, and a browser that decided "reactivate"
 *     would be a way for anyone to resume email to any address. Every filter
 *     below is re-run server-side on what was stored, and the visit has to name
 *     an identity that matches a field the browser cannot set — the alert's own
 *     denormalized `userId`.
 *  2. Four of the seven filters are statements about STORED STATE, not about the
 *     page: an active opt-out, a suppressed address, an alert the person
 *     switched off. The sender already holds all of it — it reads the newsletter
 *     document, the job-alert document and the alert in the same batched
 *     `getAll` — so the decision costs zero extra reads there and would cost
 *     three documents per page view in a Cloud Function on visit.
 *  3. The decision only has an effect at the moment we would next mail. Taking
 *     it then means taking it against the FRESHEST state: a bounce or an opt-out
 *     that lands between the visit and the send is seen, where a trigger that
 *     wrote `cadence_state: 'active'` at visit time would already have committed.
 *
 * FAIL-CLOSED, and the default is "no". Every unknown — no stamp, an unreadable
 * instant, an unrecognised session, an unreadable lifecycle state — returns a
 * refusal. The alert stays decayed, and the exit the design has always had (an
 * affirmative act in the preference centre) stays open.
 *
 * WHAT IT DOES NOT DO: it does not clear `cadence_decayed_at`,
 * `cadence_decay_reason` or `cadence_sends_at_decay`. Those record that we
 * stopped by ourselves after N attempts without anybody asking — the evidence
 * the terminal state exists to keep — and a reactivation is one more fact on top
 * of that history, not an erasure of it.
 *
 * @param {object} args
 * @param {object} args.alert the `alerts/{alertId}` document
 * @param {object|null} args.sub the `job_alert_subscribers/{email}` document
 * @param {object|null} [args.newsletter] the `newsletter_subscribers/{email}` document
 * @param {string} args.nowIso the instant to stamp the reactivation with
 * @param {object} [args.options] forwarded to classifyReturnVisit
 * @returns {{ reactivate: boolean, verdict: string, reason: string,
 *             alertFields: object|null, subFields: object|null }}
 */
export function reactivationAfterReturnVisit({ alert, sub, newsletter = null, nowIso, ...options }) {
  const no = (verdict, reason) => ({ reactivate: false, verdict, reason, alertFields: null, subFields: null });

  // Only a document we ourselves retired can come back this way. An `unknown`
  // lifecycle state is deliberately NOT repaired into `active` by a visit: we do
  // not know what it means, and guessing here would be a fail-open write.
  if (!isDecayed(alert)) return no(JOB_ALERT_REACTIVATION_BLOCKS.NOT_DECAYED, 'the alert is not in the decayed state');

  // 5. An alert the PERSON switched off, which never comes back on its own.
  // This is the whole reason decay does not touch `active`: if it did, the two
  // would be one field and this branch could not exist. `paused` is the same
  // kind of act on the other axis (#4298), and gets the same answer.
  if (alert?.active !== true) return no(JOB_ALERT_REACTIVATION_BLOCKS.SWITCHED_OFF, 'the person switched this alert off');
  if (alert?.paused === true) return no(JOB_ALERT_REACTIVATION_BLOCKS.SWITCHED_OFF, 'the person paused this alert');

  // 4. A suppressed address, and 3. this channel's own opt-out — one predicate,
  // functions/src/lib/emailSuppression.js, the same one the sender applies.
  if (isJobAlertExcluded(sub?.status)) {
    return no(JOB_ALERT_REACTIVATION_BLOCKS.SUPPRESSED, `the job-alert document says '${String(sub?.status)}'`);
  }
  // 3. A global opt-out. `isCrossChannelStop` is the predicate #5688 exists for:
  // a person who clicked "disiscriviti" left no trace at all on the job-alert
  // document, and 127 of 127 addresses suppressed after an LPD complaint kept
  // their alerts. A missing newsletter document is not an unknown — it is an
  // address that never had one, and it cannot carry an instruction to stop.
  if (newsletter && isCrossChannelStop(newsletter)) {
    return no(JOB_ALERT_REACTIVATION_BLOCKS.CHANNEL_OPT_OUT, 'the newsletter document records an opt-out or a suppression');
  }

  // 1, 2, 6 and 7 — the page load itself.
  const visit = readReturnVisitStamp(sub);
  const classified = classifyReturnVisit(visit, options);
  if (!classified.returned) return no(classified.verdict, classified.reason);

  // The identity binding. `userId` is denormalized onto every alert document
  // (services/jobAlertService.ts writes it, and the backfill copies the
  // newsletter document's `user_id`), and it is not a field the browser can set
  // on the alert — which is what turns the recorded uid from a claim into a
  // check. A backfilled alert whose subscriber never signed in carries
  // `userId: null`, so it can never be reactivated this way: that is the
  // fail-closed answer to "we do not know who this is", and those alerts keep
  // the preference-centre exit like everybody else.
  const boundUid = ownerUidOf(alert) || ownerUidOf(sub);
  if (!boundUid || boundUid !== visit.uid) {
    return no(JOB_ALERT_REACTIVATION_BLOCKS.UNIDENTIFIED, 'the session identity does not match the owner of this alert');
  }

  // A visit that happened BEFORE we gave up is not a return. Without this the
  // first run after the decay would immediately undo it, using a stamp that was
  // already on the document when the decay was written.
  const decayedAtMs = toMillis(alert?.cadence_decayed_at ?? alert?.cadenceDecayedAt);
  if (decayedAtMs == null || !(visit.atMs > decayedAtMs)) {
    return no(JOB_ALERT_REACTIVATION_BLOCKS.STALE_VISIT, 'the visit is older than the decay, or the decay has no readable instant');
  }

  // Consumed once, and once only. This is the two-slot guard again, on the other
  // axis: without it the second run of the day would read the same stamp and
  // write the same reactivation, and a rerun would not be a no-op.
  const consumedMs = toMillis(sub?.ja_cadence_return_visit_consumed_at ?? sub?.jaCadenceReturnVisitConsumedAt);
  const reactivatedMs = toMillis(alert?.cadence_reactivated_at ?? alert?.cadenceReactivatedAt);
  for (const seen of [consumedMs, reactivatedMs]) {
    if (seen != null && visit.atMs <= seen) {
      return no(JOB_ALERT_REACTIVATION_BLOCKS.ALREADY_CONSUMED, 'this visit has already been acted on');
    }
  }

  const visitIso = new Date(visit.atMs).toISOString();
  return {
    reactivate: true,
    verdict: JOB_ALERT_REACTIVATION_BLOCKS.OK,
    reason: `return visit at ${visitIso} by the person who owns this alert`,
    alertFields: {
      cadence_state: JOB_ALERT_CADENCE_STATES.ACTIVE,
      cadence_reactivated_at: nowIso,
      cadence_reactivation_visit_at: visitIso,
      cadence_reactivation_reason: 'return visit to the site',
    },
    // The counters have to be reset or the reactivation is theatre: the decay
    // counter is already at N, so the very next send would re-stamp the terminal
    // state and the alert would come back for exactly one email.
    //
    // The TIER is deliberately left alone. A visit to a web page is not a click
    // on a job advert, and "engagement is a measurement, and a measurement is
    // never permission" — coming back earns the cadence the person's own signal
    // already earns them, no more. It is also the only way to keep this write
    // free of side effects on the recipient's OTHER alerts, which share these
    // per-recipient fields.
    subFields: {
      ja_cadence_weekly_sends: 0,
      ja_cadence_sends_since_engagement: 0,
      ja_cadence_return_visit_consumed_at: visitIso,
    },
  };
}
