/**
 * dailyBriefCadence.mjs — per-recipient send cadence for the daily brief.
 *
 * WHY (issue #5415 §1C, §3)
 * ─────────────────────────
 * The brief launched as a fixed daily cohort: everyone eligible, every morning.
 * With ~7k eligible addresses and a cascade cap around 4.5k that has two
 * consequences, both bad. People who never open it get an email a day — the
 * exact signal that teaches Gmail and Yahoo to filter the domain — and, because
 * the capacity cut is a deterministic `slice(0, cap)` over an alphabetical
 * list, the ~2.5k addresses past the cut would never receive a single edition.
 *
 * So frequency follows engagement: 1 → 2 → 3 → 5 → 7 days between sends.
 * Promotion is IMMEDIATE (one click moves a recipient a tier toward daily),
 * demotion is SLOW (three consecutive sends with no engagement move one tier
 * down, never past weekly). That asymmetry is the hysteresis: a reader who goes
 * quiet for a week is not punished for it, and a reader who comes back gets the
 * daily edition the next morning.
 *
 * PURE. No I/O, no `Date.now()`: `nowMs` and `todayIso` are arguments, the way
 * scripts/lib/jobAlertEngagementTier.mjs (the job-alert classifier this is
 * modelled on) takes `nowMs`. That is what makes the rerun and the two-cron-slot
 * behaviour testable — see `isDueToday`.
 *
 * ITS OWN FIELDS. State lives in `daily_brief_*` fields on
 * `newsletter_subscribers/{email}`. It must NEVER be `last_sent_at`: that field
 * is the 36-hour mutex between the weekly newsletter and the job alerts
 * (send-daily-brief.mjs's own header explains that writing it would starve both
 * channels and reading it as a cooldown would make a daily channel impossible).
 * The cross-channel guard here READS that field — a same-day calendar check is
 * not a 36h cooldown — and never writes it.
 *
 * TWO THINGS A CLICK IS NOT (issues #5674, #5679)
 * ───────────────────────────────────────────────
 * 1. A click is not proof a human read anything. Corporate mail security opens
 *    every link of every message at delivery, unsubscribe included, and the
 *    promotion above turned that into "enthusiastic reader → daily". Worse, it
 *    self-feeds: more sends produce more synthetic clicks produce a faster tier.
 *    `classifyClickEvents` is the single definition of which clicks count.
 * 2. A click is not consent. The accepted formula names a periodicity, and that
 *    periodicity is a CEILING the engine may move below but never above —
 *    `consentCeilingDays`. Only the reader can lift it, by pinning a frequency;
 *    measured engagement never can.
 */

import {
  EMAIL_SCANNER_IP_RANGES,
  SCAN_BURST_MIN_TARGETS,
  SCAN_BURST_WINDOW_MS,
  classifyClickEvents,
  ipInCidr,
  isAutomationAgent,
  isOptOutLink,
  isScannerIp,
  toMillis,
} from './syntheticClicks.mjs';
import {
  ENGAGEMENT_BLIND_PROVIDERS,
  daysBetweenIso,
  estimateDailyVolume,
  utcDayOf,
} from './cadenceCalendar.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Which clicks are a person" moved to scripts/lib/syntheticClicks.mjs (#5767)
 * — a shim onto functions/src/lib/syntheticClicks.js, where it has to live so
 * the Cloud Function that writes the engagement score can read the same rule —
 * and is re-exported here unchanged, so every existing importer of this module
 * keeps working verbatim. Same shape this file already used for
 * EMAIL_SCANNER_IP_RANGES, which now travels with it.
 *
 * It moved because it was never only the brief's: the job-alert channel runs a
 * second engagement-driven cadence and was still promoting off a raw
 * `last_click_at`, and `calculateEngagementScore` a third. The rule is
 * calibrated on a measurement (see the file), so the choice was one home or
 * three drifting copies, and the copy that drifts is the shape of #5674 itself.
 */
export {
  EMAIL_SCANNER_IP_RANGES,
  SCAN_BURST_MIN_TARGETS,
  SCAN_BURST_WINDOW_MS,
  classifyClickEvents,
  ipInCidr,
  isAutomationAgent,
  isOptOutLink,
  isScannerIp,
  toMillis,
};

/**
 * The calendar arithmetic, the blind-provider set and the volume estimator
 * moved to scripts/lib/cadenceCalendar.mjs (#5705) for the same reason: the
 * job-alert channel now runs a second cadence engine, and "how many days since
 * we last mailed this person" has to be the SAME answer on both. Re-exported
 * here unchanged — third application of the shim shape above, and the reason
 * this file's tests did not have to move with them.
 */
export {
  ENGAGEMENT_BLIND_PROVIDERS,
  daysBetweenIso,
  estimateDailyVolume,
  utcDayOf,
};

/** Days between sends, ordered from most to least frequent. */
export const DAILY_BRIEF_TIERS = Object.freeze([1, 2, 3, 5, 7]);

/** Consecutive engagement-free sends before a recipient drops one tier. */
export const DEMOTION_STREAK = 3;

/** Lookback for the initial seed from the history the webhooks already wrote. */
export const SEED_LOOKBACK_DAYS = 30;

/**
 * What the preferences page can pin, and what it means in days. The user's
 * choice beats the engine verbatim — same precedent as the job-alert
 * `frequencyOverride` (jobAlertEngagementTier.mjs `resolveEffectiveJobAlertTier`).
 * `off` is a channel-level opt-out that leaves the other channels alone.
 */
export const FREQUENCY_OVERRIDES = Object.freeze({
  daily: 1,
  'every-2': 2,
  'every-3': 3,
  'every-5': 5,
  weekly: 7,
  off: null,
});

// ── helpers ────────────────────────────────────────────────────────────────

/** Snap any stored number onto the nearest tier at or below it, floor 1 day. */
export function normalizeTier(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return null;
  if (n <= DAILY_BRIEF_TIERS[0]) return DAILY_BRIEF_TIERS[0];
  for (let i = DAILY_BRIEF_TIERS.length - 1; i >= 0; i--) {
    if (n >= DAILY_BRIEF_TIERS[i]) return DAILY_BRIEF_TIERS[i];
  }
  return DAILY_BRIEF_TIERS[0];
}

const tierIndex = (days) => Math.max(0, DAILY_BRIEF_TIERS.indexOf(normalizeTier(days)));
const promote = (days) => DAILY_BRIEF_TIERS[Math.max(0, tierIndex(days) - 1)];
const demote = (days) => DAILY_BRIEF_TIERS[Math.min(DAILY_BRIEF_TIERS.length - 1, tierIndex(days) + 1)];

/**
 * When this recipient last clicked something a person plausibly clicked.
 *
 * Three sources, most trustworthy first:
 *  1. `clickEvents` handed in by the caller — the full history, so every rule
 *     in scripts/lib/syntheticClicks.mjs can fire.
 *  2. `daily_brief_last_human_click_at`, if a backfill has already classified
 *     the history and written the answer down.
 *  3. the subscriber-level `last_click_at`, run through the same classifier as
 *     a one-event history. It carries no IP and no timestamps of its
 *     neighbours, so only the URL rules can fire — but `last_clicked_url` is
 *     written beside it by every webhook, and that is enough for the rule that
 *     matters most: measured on 2026-08-12, 68 of the 433 recipients on the
 *     daily tier had the OPT-OUT LINK as their most recent click.
 *
 * Falling through to `null` is the conservative answer, not a guess: without a
 * usable click the seed drops to the open-based tier, and one genuine click
 * later promotes the recipient straight back.
 */
export function lastHumanClickAtMs(sub, { clickEvents = null, scannerRanges = EMAIL_SCANNER_IP_RANGES } = {}) {
  if (Array.isArray(clickEvents)) {
    return classifyClickEvents(clickEvents, { scannerRanges }).lastHumanClickAtMs;
  }
  const precomputed = toMillis(sub?.daily_brief_last_human_click_at);
  if (precomputed != null) return precomputed;
  const raw = toMillis(sub?.last_click_at ?? sub?.lastClickAt);
  if (raw == null) return null;
  return classifyClickEvents(
    [{ at: raw, url: sub?.last_clicked_url ?? sub?.lastClickedUrl ?? '' }],
    { scannerRanges },
  ).lastHumanClickAtMs;
}

// ── the ceiling the accepted formula sets (#5679) ──────────────────────────

/**
 * What we assume when the document does not say. The formula actually in use
 * says "newsletter **settimanale**", and on 2026-08-12 only 100 of 8.618
 * documents had a `consent_text` at all (#5678 is why) — so the assumption
 * governs almost everybody. Weekly is the value of the formula we know we
 * showed, and it is the safe direction: too slow is a product problem, too fast
 * is an LPD art. 25/32 problem, and we already have the letter.
 */
export const CONSENT_DEFAULT_MAX_FREQUENCY_DAYS = 7;

/**
 * Periodicity words in the four locales, most restrictive first. When a text
 * names more than one, the LEAST frequent wins: an ambiguous consent is read
 * against the sender.
 */
const CONSENT_PERIODICITY = Object.freeze([
  { days: 30, re: /\bmensil\w*|\bmonthly\b|\bmonatlich\b|\bmensuel\w*|ogni mese|once a month/i },
  { days: 7, re: /\bsettimanal\w*|\bweekly\b|\bw[oö]chentlich\w*|\bhebdomadaire\w*|ogni settimana|once a week/i },
  { days: 1, re: /\bquotidian\w*|\bgiornalier\w*|\bdaily\b|\bt[aä]glich\w*|\bjournalier\w*|ogni giorno|every day/i },
]);

/**
 * The periodicity an accepted formula declares, in days, or `null` when it
 * declares none. Eight of the ten non-weekly formulas on file name no
 * periodicity at all ("accetto di ricevere la newsletter per frontalieri"),
 * and inventing one for them would be exactly the fabrication #5679 forbids —
 * they get `null`, and the caller applies the default.
 *
 * CALL THIS ONCE, at capture or in a backfill, and store the answer in
 * `consent_max_frequency_days`. The engine must not re-parse prose on every
 * send: the formula will change, and a regex scattered across the send path is
 * the next silent defect (#5679, explicit).
 *
 * @param {string|null|undefined} consentText
 * @returns {number|null}
 */
export function consentMaxFrequencyDays(consentText) {
  if (typeof consentText !== 'string' || consentText.trim() === '') return null;
  for (const { days, re } of CONSENT_PERIODICITY) {
    if (re.test(consentText)) return days;
  }
  return null;
}

/**
 * The ceiling that governs this document today: the STORED value, or the
 * default when there is none.
 *
 * Deliberately blind to `sub.consent_text` — see `consentMaxFrequencyDays`.
 * That also makes the missing-field case safe by construction: an unbackfilled
 * document gets the prudent 7 rather than whatever a fresh parse would invent.
 */
export function consentCeilingDays(sub) {
  const stored = Number(sub?.consent_max_frequency_days ?? sub?.consentMaxFrequencyDays);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return CONSENT_DEFAULT_MAX_FREQUENCY_DAYS;
}

// ── seeding ────────────────────────────────────────────────────────────────

/**
 * The tier a recipient starts on, read off the engagement history the provider
 * webhooks have been writing for months (issue #5415 §3.5, option B).
 *
 * The alternative — everyone daily, demote from there — would send ~7k emails a
 * day for the first week to ~5k people who have not clicked anything in a
 * month. That is the spam this whole mechanism exists to prevent, and it is
 * over the cascade's capacity anyway.
 *
 * WHICH CLICK (#5674). The lookback reads the last HUMAN click, not the last
 * click: `lastHumanClickAtMs` drops the ones a scanner, a library or an opt-out
 * link produced. Measured on the 433 recipients this seed had put on the daily
 * tier, 73 of them got there on clicks that were all synthetic — 64 of those on
 * a single click of the unsubscribe link.
 *
 * @param {object} sub `newsletter_subscribers/{email}` fields
 * @param {number} nowMs
 * @param {object} [options]
 * @param {Array<object>|null} [options.clickEvents] the recipient's click
 *        history, when the caller has read it; without it the classifier still
 *        runs on the one click the document remembers.
 * @returns {{ tierDays: number, reason: string }}
 */
export function seedTier(sub, nowMs, { clickEvents = null } = {}) {
  const lookbackMs = SEED_LOOKBACK_DAYS * DAY_MS;
  const lastClick = lastHumanClickAtMs(sub, { clickEvents });
  const lastOpen = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);

  if (lastClick != null && nowMs - lastClick <= lookbackMs) {
    return { tierDays: 1, reason: `clicked ${Math.floor((nowMs - lastClick) / DAY_MS)}d ago` };
  }
  if (lastOpen != null && nowMs - lastOpen <= lookbackMs) {
    return { tierDays: 3, reason: `opened ${Math.floor((nowMs - lastOpen) / DAY_MS)}d ago, no recent click` };
  }
  // Silence we cannot interpret is not silence. Someone whose mail has only
  // ever gone out through Cloudflare has no open/click history because nothing
  // was ever able to record one — seeding them weekly would punish our own
  // blind spot, so they start in the middle (§3.2d, §3.5).
  if (sub?.daily_brief_last_send_provider && ENGAGEMENT_BLIND_PROVIDERS.has(sub.daily_brief_last_send_provider)
    && lastClick == null && lastOpen == null) {
    return { tierDays: 3, reason: 'no engagement signal possible (blind provider only)' };
  }
  return {
    tierDays: 7,
    reason: lastClick == null && lastOpen == null
      ? 'never opened or clicked'
      : `last engagement beyond ${SEED_LOOKBACK_DAYS}d`,
  };
}

/**
 * The cadence that actually governs this recipient today.
 *
 * THE CEILING (#5679). What the reader accepted is an upper bound on frequency,
 * and the engine may only move BELOW it. The order is therefore:
 *
 *   1. a frequency the reader pinned          → verbatim, ceiling included.
 *      They are the party the consent protects; when they ask for the daily
 *      edition, asking is the consent. This is the ONLY way past the ceiling.
 *   2. the engine tier, or a fresh seed       → then clamped to the ceiling.
 *      Engagement is a measurement, and a measurement is never permission.
 *
 * The engine tier underneath is left uncapped on purpose (`nextCadenceState`
 * keeps tracking it): the ceiling is a read-time policy, so a corrected consent
 * text or a new formula changes what people receive without a data migration,
 * and nothing has been overwritten in the meantime.
 *
 * @returns {{ tierDays: number|null, source: 'override'|'state'|'seed', reason: string,
 *             consentMaxDays: number, consentCapped: boolean }}
 *          `tierDays: null` means the recipient turned the channel off.
 */
export function resolveTier(sub, nowMs) {
  const consentMaxDays = consentCeilingDays(sub);
  const override = sub?.daily_brief_frequency_override;
  if (override != null && Object.prototype.hasOwnProperty.call(FREQUENCY_OVERRIDES, override)) {
    return {
      tierDays: FREQUENCY_OVERRIDES[override],
      source: 'override',
      reason: `user pinned "${override}"`,
      consentMaxDays,
      consentCapped: false,
    };
  }

  const stored = normalizeTier(sub?.daily_brief_tier);
  const base = stored != null
    ? { tierDays: stored, source: 'state', reason: 'engine tier' }
    : { ...seedTier(sub, nowMs), source: 'seed' };

  if (base.tierDays != null && base.tierDays < consentMaxDays) {
    return {
      tierDays: consentMaxDays,
      source: base.source,
      reason: `${base.reason}; capped at ${consentMaxDays}d by accepted consent`,
      consentMaxDays,
      consentCapped: true,
    };
  }
  return { ...base, consentMaxDays, consentCapped: false };
}

// ── the send decision ──────────────────────────────────────────────────────

/**
 * Is this recipient due an edition today?
 *
 * A pure function of (stored state, todayIso) — which is what makes the two
 * cron slots safe. The 06:33 and 09:33 runs share a `TODAY_ISO`, so they compute
 * the SAME due set; the second slot only picks up whoever the first could not
 * reach, and nobody becomes newly due between them (§3.12e). It is also what
 * makes a same-day rerun a no-op: everyone served already carries today's
 * `daily_brief_last_sent_at`.
 *
 * @param {object} sub
 * @param {string} todayIso YYYY-MM-DD
 * @param {number} nowMs
 * @returns {{ due: boolean, tierDays: number|null, source: string, reason: string, waitDays: number }}
 */
export function isDueToday(sub, todayIso, nowMs) {
  const { tierDays, source, reason, consentMaxDays, consentCapped } = resolveTier(sub, nowMs);
  // Carried through so the sender can log WHY somebody is not due today: a
  // consent ceiling and a quiet reader look identical in the tier alone.
  const verdict = { tierDays, source, consentMaxDays, consentCapped };
  if (tierDays == null) {
    return { ...verdict, due: false, reason: 'channel off (user preference)', waitDays: Infinity };
  }
  const lastIso = utcDayOf(sub?.daily_brief_last_sent_at);
  if (!lastIso) {
    return { ...verdict, due: true, reason: `${reason}; never sent`, waitDays: 0 };
  }
  const elapsed = daysBetweenIso(lastIso, todayIso);
  if (elapsed == null) return { ...verdict, due: true, reason: `${reason}; unreadable last send`, waitDays: 0 };
  return {
    ...verdict,
    due: elapsed >= tierDays,
    reason: `${reason}; ${elapsed}d since last send, tier ${tierDays}d`,
    waitDays: Math.max(0, tierDays - elapsed),
  };
}

/**
 * "Niente notizia, niente email" (§3.9). The corpus already degrades per block
 * and publishes how many it could measure; the sender refuses outright below
 * two. Between two and three, only the recipients who are effectively asking
 * for it daily still get one — a thin edition is not worth a slot for someone
 * on a weekly cadence.
 *
 * @param {number} availableBlocks `brief.counts.availableBlocks`
 * @param {number} tierDays
 */
export function passesBlockGate(availableBlocks, tierDays) {
  const blocks = Number(availableBlocks);
  if (!Number.isFinite(blocks) || blocks < 2) return false;
  if (blocks >= 4) return true;
  return Number(tierDays) <= 2;
}

/**
 * Max one email per recipient per UTC day, across every channel (§3.3).
 *
 * READS `newsletter_subscribers.last_sent_at` and
 * `job_alert_subscribers.last_sent_at` — the timestamps the weekly newsletter
 * and the job alerts write — plus the onboarding drip's own field, and skips a
 * recipient who already heard from us today. Reading is what the sender's
 * header rules out doing as a 36h COOLDOWN, not as a calendar check: those two
 * channels touch a given person about once a week, so a same-day check costs
 * the brief roughly one day in seven, while a 36h cooldown would cost it every
 * other day.
 *
 * Nothing here writes. The 36h mutex between newsletter and job-alert is
 * untouched.
 */
export function blockedByAnotherChannelToday({ nlDoc, jaDoc, todayIso }) {
  const candidates = [
    ['newsletter', nlDoc?.last_sent_at],
    ['job-alert', jaDoc?.last_sent_at],
    ['drip', nlDoc?.drip_last_sent_at],
  ];
  for (const [channel, value] of candidates) {
    if (utcDayOf(value) === todayIso) return { blocked: true, channel };
  }
  return { blocked: false, channel: null };
}

/**
 * The state to write after this morning's send, given what happened since the
 * previous one.
 *
 * Promotion first: any engagement resets the streak AND moves a tier toward
 * daily, so a returning reader is back on the daily edition tomorrow. Only when
 * there was no engagement does the streak grow, and only if the previous send
 * could have PRODUCED a signal — a Cloudflare delivery is invisible to us and
 * must not count toward demoting somebody (§3.2d).
 *
 * @param {object} args
 * @param {object} args.sub current subscriber fields
 * @param {boolean} args.engaged a click (or attributed return) since the last send
 * @param {boolean} [args.opened] an open since the last send — a weak signal:
 *        Apple Mail Privacy Protection prefetches inflate opens, so an open
 *        HOLDS the current tier but never promotes (§3.2b)
 * @param {string} args.sentAtIso ISO timestamp of the send being recorded
 * @param {string} args.provider the cascade provider that carried it
 * @returns {{ daily_brief_tier: number, daily_brief_last_sent_at: string,
 *             daily_brief_sends_since_engagement: number,
 *             daily_brief_tier_updated_at: string|undefined,
 *             daily_brief_last_send_provider: string|null }}
 */
export function nextCadenceState({ sub, engaged, opened = false, sentAtIso, provider }) {
  // The ENGINE tier, not the effective one: a recipient who pinned a frequency
  // still has their engine tier tracked underneath, so removing the pin later
  // lands them on a current estimate instead of a stale one.
  const sentAtMs = Date.parse(sentAtIso) || 0;
  const current = normalizeTier(sub?.daily_brief_tier) ?? normalizeTier(seedTier(sub, sentAtMs).tierDays) ?? 7;
  const previousProvider = sub?.daily_brief_last_send_provider ?? null;
  const previousStreak = Number(sub?.daily_brief_sends_since_engagement) || 0;

  let tier = current;
  let streak = previousStreak;

  if (engaged) {
    tier = promote(current);
    streak = 0;
  } else if (opened) {
    streak = 0; // held, not promoted
  } else if (previousProvider && ENGAGEMENT_BLIND_PROVIDERS.has(previousProvider)) {
    // The previous send could not have reported anything. Neither promote nor
    // count it against the recipient.
  } else if (sub?.daily_brief_last_sent_at) {
    streak = previousStreak + 1;
    if (streak >= DEMOTION_STREAK) {
      tier = demote(current);
      streak = 0;
    }
  }

  return {
    daily_brief_tier: tier,
    daily_brief_last_sent_at: sentAtIso,
    daily_brief_sends_since_engagement: streak,
    ...(tier !== current ? { daily_brief_tier_updated_at: sentAtIso } : {}),
    daily_brief_last_send_provider: provider ?? null,
  };
}

/**
 * Did this recipient engage since the brief last reached them?
 *
 * `briefClickAtMs` is the click ATTRIBUTED TO THE BRIEF (a `clicked_at` on a
 * `campaign_deliveries` doc whose `campaign_id` starts with `daily-brief-`),
 * which is the honest signal. When that attribution is unavailable the caller
 * passes the subscriber-level `last_click_at` instead and says so — a click on
 * the weekly counts as engagement with US, which keeps someone on a faster
 * cadence than the brief alone earns. That is the safe direction to be wrong in
 * only for the reader, so the sender logs which mode it ran in.
 *
 * WHICHEVER MODE, the click still has to look like a person (#5674). In
 * brief-attributed mode the sender drops opt-out clicks from the map it builds;
 * in subscriber-level mode `lastHumanClickAtMs` applies the same rules here.
 * Promotion is immediate by design, so this is the one place where a single
 * synthetic click buys a whole tier — which is how a scanner walked recipients
 * up to the daily edition one send at a time.
 */
export function engagedSinceLastSend({ sub, briefClickAtMs = null, clickEvents = null }) {
  const lastSent = toMillis(sub?.daily_brief_last_sent_at);
  if (lastSent == null) return false; // nothing sent yet — nothing to react to
  const click = briefClickAtMs ?? lastHumanClickAtMs(sub, { clickEvents });
  return click != null && click > lastSent;
}

/** Same question for opens — the weak signal that holds a tier (§3.2b). */
export function openedSinceLastSend(sub) {
  const lastSent = toMillis(sub?.daily_brief_last_sent_at);
  if (lastSent == null) return false;
  const open = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);
  return open != null && open > lastSent;
}

