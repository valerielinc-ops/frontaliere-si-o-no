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
 *     `cadence_state: 'decayed'` once a backfilled alert has taken
 *     JOB_ALERT_DECAY_AFTER_SLOW_SENDS sends on the slowest tier without a
 *     single signal.
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
 * Only these decay. The asymmetry is the owner's D6: the slower intervals apply
 * to everybody (they are all ≥ today's, so nobody receives MORE), but retiring
 * an alert somebody deliberately created is a different decision and not this
 * one.
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

// ── the send decision ──────────────────────────────────────────────────────

/**
 * Is this alert due today?
 *
 * Pure function of (alert, subscriber, todayIso) — which is what makes a rerun
 * a no-op and absorbs the cron's 240-minute median dispatch delay.
 *
 * Three gates, all of which must pass:
 *   - the alert's lifecycle state is `active` (fail-closed: see cadenceStateOf);
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

  const gates = [
    ['alert', utcDayOf(alert?.lastMatchedAt)],
    ...(cadence.manual ? [] : [['recipient', utcDayOf(sub?.ja_cadence_last_sent_at)]]),
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
  return toMillis(sub?.ja_cadence_last_sent_at) ?? toMillis(sub?.last_sent_at) ?? null;
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
 * @param {string} args.sentAtIso ISO timestamp of the send being recorded
 * @param {string|null} [args.provider] the cascade provider that carried it
 */
export function nextJobAlertCadenceState({ sub, engaged, opened = false, sentAtIso, provider = null }) {
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
    ...(tier !== current ? { ja_cadence_tier_updated_at: sentAtIso } : {}),
  };
}

/**
 * The terminal stamp to write on the ALERT document, or `null` when this send
 * does not retire it.
 *
 * Preconditions, each of which is a decision and not a detail:
 *   - the alert came from the backfill (owner's D6: an alert somebody created
 *     on purpose is not retired by this mechanism);
 *   - it is not manually pinned (the pin is the person's own act);
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
  if (!isBackfilledAlert(alert)) return null;
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
