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
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * Providers whose sends are invisible to us. Cloudflare has no webhook at all
 * ("no open/click", scripts/check-email-quotas.mjs), so a Cloudflare send that
 * draws no click proves nothing — counting it toward the demotion streak would
 * demote people for OUR blind spot. It is excluded from the denominator
 * (issue #5415 §3.2d).
 */
export const ENGAGEMENT_BLIND_PROVIDERS = Object.freeze(new Set(['cloudflare']));

// ── helpers ────────────────────────────────────────────────────────────────

/** Firestore Timestamp | Date | ISO string | millis → millis, or null. */
export function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

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
 * @param {object} sub `newsletter_subscribers/{email}` fields
 * @param {number} nowMs
 * @returns {{ tierDays: number, reason: string }}
 */
export function seedTier(sub, nowMs) {
  const lookbackMs = SEED_LOOKBACK_DAYS * DAY_MS;
  const lastClick = toMillis(sub?.last_click_at ?? sub?.lastClickAt);
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
 * @returns {{ tierDays: number|null, source: 'override'|'state'|'seed', reason: string }}
 *          `tierDays: null` means the recipient turned the channel off.
 */
export function resolveTier(sub, nowMs) {
  const override = sub?.daily_brief_frequency_override;
  if (override != null && Object.prototype.hasOwnProperty.call(FREQUENCY_OVERRIDES, override)) {
    return { tierDays: FREQUENCY_OVERRIDES[override], source: 'override', reason: `user pinned "${override}"` };
  }
  const stored = normalizeTier(sub?.daily_brief_tier);
  if (stored != null) return { tierDays: stored, source: 'state', reason: 'engine tier' };
  const seeded = seedTier(sub, nowMs);
  return { ...seeded, source: 'seed' };
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
  const { tierDays, source, reason } = resolveTier(sub, nowMs);
  if (tierDays == null) {
    return { due: false, tierDays: null, source, reason: 'channel off (user preference)', waitDays: Infinity };
  }
  const lastIso = utcDayOf(sub?.daily_brief_last_sent_at);
  if (!lastIso) {
    return { due: true, tierDays, source, reason: `${reason}; never sent`, waitDays: 0 };
  }
  const elapsed = daysBetweenIso(lastIso, todayIso);
  if (elapsed == null) return { due: true, tierDays, source, reason: `${reason}; unreadable last send`, waitDays: 0 };
  const waitDays = Math.max(0, tierDays - elapsed);
  return {
    due: elapsed >= tierDays,
    tierDays,
    source,
    reason: `${reason}; ${elapsed}d since last send, tier ${tierDays}d`,
    waitDays,
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
 */
export function engagedSinceLastSend({ sub, briefClickAtMs = null }) {
  const lastSent = toMillis(sub?.daily_brief_last_sent_at);
  if (lastSent == null) return false; // nothing sent yet — nothing to react to
  const click = briefClickAtMs ?? toMillis(sub?.last_click_at ?? sub?.lastClickAt);
  return click != null && click > lastSent;
}

/** Same question for opens — the weak signal that holds a tier (§3.2b). */
export function openedSinceLastSend(sub) {
  const lastSent = toMillis(sub?.daily_brief_last_sent_at);
  if (lastSent == null) return false;
  const open = toMillis(sub?.last_open_at ?? sub?.lastOpenAt);
  return open != null && open > lastSent;
}

/**
 * Expected daily volume for a tier distribution — what the dry-run prints so a
 * rollout decision is made against the cascade cap instead of a hope (§3.6).
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
