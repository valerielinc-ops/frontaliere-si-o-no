/**
 * Per-user scheduled-send time resolution (feature #3798).
 *
 * Pure functions that turn a subscriber's derived "best time to open/click"
 * (computed by functions/src/lib/preferredSendHour.js and persisted on the
 * subscriber doc as `preferred_send_hour_utc`/`preferred_send_sample_count`)
 * into a concrete UTC timestamp the send scripts hand to the email cascade
 * via `payload.scheduledAt` (see scripts/lib/email-cascade.mjs).
 *
 * No Firestore access here beyond what the caller already has in hand — this
 * module only computes. The one exception is the env-driven kill switch
 * (perUserSendTimeEnabled), which is process-local and not a Firestore read.
 * logScheduleDistribution is the one function here that's reporting rather
 * than pure computation (console.log), shared by both send scripts' dry-run
 * output — see its own docblock below.
 */

import { PREFERRED_SEND_MIN_EVENTS, circularMeanToHour } from '../../functions/src/lib/preferredSendHour.js';

// ── Kill switch (Fase 4 rollback) ────────────────────────────
// PER_USER_SEND_TIME=off|0|false disables per-user scheduling; everything
// else (including unset) keeps it on. Read live (not cached at module load)
// so tests can flip process.env between assertions.
const DISABLED_VALUES = new Set(['off', '0', 'false']);

export function perUserSendTimeEnabled() {
  const raw = (process.env.PER_USER_SEND_TIME ?? 'on').trim().toLowerCase();
  return !DISABLED_VALUES.has(raw);
}

function isValidHour(hourUtc) {
  return Number.isInteger(hourUtc) && hourUtc >= 0 && hourUtc <= 23;
}

// Tiny deterministic string hash (FNV-1a, 32-bit) — no dependency needed for
// a jitter value. Same email always yields the same minute, so re-running the
// send script never reshuffles a subscriber's slot, but different subscribers
// spread out across the hour instead of all landing on :00 (which would just
// recreate the "everyone gets it at the top of the hour" burst this feature
// exists to avoid).
function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Resolve the concrete UTC instant a given subscriber's email should be
 * scheduled for, given their preferred send hour.
 *
 * Design decision (owner, issue #3798 — "today or tomorrow"): the candidate
 * slot is always TODAY at preferredHourUtc:minute first; only pushed to
 * tomorrow if that slot has already passed (or falls inside the anti-race
 * `minLeadMs` margin the email cascade also enforces — see
 * resolveScheduledAt in email-cascade.mjs). One consequence worth flagging
 * for reviewers: for a preferred hour that's earlier in the day than the
 * cron run's own hour, every day's run will find "today's slot" already
 * passed and push to tomorrow — so that subscriber stably receives the send
 * ~24h+ε after each run, always at their preferred hour. This is still
 * exactly 1 email/day (the newsletter/job-alert cron itself runs once daily),
 * so there's no double-send risk; it just means "their hour, next
 * occurrence" rather than "today no matter what".
 *
 * @param {object} params
 * @param {number} params.preferredHourUtc - integer 0-23, or anything else → null result
 * @param {string} params.email - used only for the deterministic minute jitter
 * @param {Date} [params.now] - injectable for deterministic tests
 * @param {number} [params.minLeadMs] - anti-race lead time (default 15 min)
 * @returns {string|null} ISO 8601 UTC timestamp, or null when preferredHourUtc is invalid
 */
export function computeScheduledSendAt({ preferredHourUtc, email, now = new Date(), minLeadMs = 15 * 60 * 1000 }) {
  if (!isValidHour(preferredHourUtc)) return null;

  const minute = fnv1aHash(String(email || '')) % 60;

  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    preferredHourUtc,
    minute,
    0,
    0,
  ));

  if (candidate.getTime() < now.getTime() + minLeadMs) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  return candidate.toISOString();
}

/**
 * Resolve which preferred-hour source applies for a single recipient, in
 * priority order: their own personal signal, then a fallback doc's personal
 * signal (job-alerts falls back to the subscriber's newsletter doc when the
 * job_alert_subscribers doc has no data of its own), then the site-wide
 * global hour, then no preference at all (send immediately).
 *
 * Accepts either the raw Firestore field names (`preferred_send_hour_utc` /
 * `preferred_send_sample_count`, as read directly off a Firestore doc) or the
 * camelCase projection subscriberFromFirestoreRow.mjs exposes
 * (`preferredSendHourUtc` / `preferredSendSampleCount`) — callers pass
 * whichever shape they already have in hand.
 *
 * IMPORTANT: hour 0 is a valid, falsy-looking value — every check here uses
 * Number.isInteger/explicit comparisons, never `||` or truthiness, so
 * midnight doesn't get silently treated as "no preference".
 *
 * @param {object} params
 * @param {object|null} params.subscriberDoc
 * @param {object|null} [params.fallbackDoc]
 * @param {number|null} [params.globalHour]
 * @param {number} [params.minEvents] - default PREFERRED_SEND_MIN_EVENTS, imported from
 *   functions/src/lib/preferredSendHour.js so the two thresholds can't drift apart
 * @returns {{ hourUtc: number|null, source: 'personal'|'fallback-doc'|'global'|null }}
 */
export function resolveEffectivePreferredHour({ subscriberDoc, fallbackDoc = null, globalHour = null, minEvents = PREFERRED_SEND_MIN_EVENTS }) {
  const personal = readPreferredHour(subscriberDoc);
  if (isValidHour(personal.hourUtc) && personal.sampleCount >= minEvents) {
    return { hourUtc: personal.hourUtc, source: 'personal' };
  }

  const fallback = readPreferredHour(fallbackDoc);
  if (fallbackDoc && isValidHour(fallback.hourUtc) && fallback.sampleCount >= minEvents) {
    return { hourUtc: fallback.hourUtc, source: 'fallback-doc' };
  }

  if (isValidHour(globalHour)) {
    return { hourUtc: globalHour, source: 'global' };
  }

  return { hourUtc: null, source: null };
}

function readPreferredHour(doc) {
  if (!doc) return { hourUtc: null, sampleCount: 0 };
  const hourUtc = doc.preferred_send_hour_utc ?? doc.preferredSendHourUtc ?? null;
  const sampleCount = Number(doc.preferred_send_sample_count ?? doc.preferredSendSampleCount ?? 0);
  return { hourUtc, sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0 };
}

// Minimum number of qualified users (personal hour + enough samples) required
// before the global fallback hour is trusted at all — below this, a handful
// of early adopters could skew the whole site's default. Owner decision,
// issue #3798.
export const MIN_GLOBAL_SAMPLE_USERS = 5;

/**
 * Site-wide fallback preferred hour: an UNWEIGHTED circular mean of every
 * qualified user's personal `preferred_send_hour_utc` (same circular-mean
 * approach as functions/src/lib/preferredSendHour.js's computePreferredSendHour
 * — hours wrap at midnight, so this is NOT an arithmetic average). Shares the
 * angle-to-hour conversion (circularMeanToHour) with that module directly,
 * rather than re-deriving the atan2/wrap/round math here.
 *
 * @param {Array<object>} subscriberDatas - raw-shaped docs/rows (see readPreferredHour)
 * @param {number} [minEvents] - per-user qualification threshold, default PREFERRED_SEND_MIN_EVENTS
 *   (functions/src/lib/preferredSendHour.js)
 * @returns {{ hourUtc: number|null, sampleUsers: number }}
 */
export function computeGlobalPreferredHour(subscriberDatas, minEvents = PREFERRED_SEND_MIN_EVENTS) {
  let sumSin = 0;
  let sumCos = 0;
  let sampleUsers = 0;

  for (const data of Array.isArray(subscriberDatas) ? subscriberDatas : []) {
    const { hourUtc, sampleCount } = readPreferredHour(data);
    if (!isValidHour(hourUtc) || sampleCount < minEvents) continue;

    sampleUsers += 1;
    const theta = (2 * Math.PI * hourUtc) / 24;
    sumSin += Math.sin(theta);
    sumCos += Math.cos(theta);
  }

  // Owner decision, issue #3798: fewer than MIN_GLOBAL_SAMPLE_USERS qualified
  // users → too noisy to trust a site-wide default, fall back to null (no
  // global preference; recipients without a personal hour get sent immediately).
  if (sampleUsers < MIN_GLOBAL_SAMPLE_USERS) {
    return { hourUtc: null, sampleUsers };
  }

  const hourUtc = circularMeanToHour(sumSin, sumCos);

  return { hourUtc, sampleUsers };
}

// ── Per-user send-time distribution (dry-run/preview reporting, #3798) ──────

// Preferred display order for known sources — keeps the log line's column
// order stable across runs. Any source not in this list (a future addition)
// is still counted (see logScheduleDistribution below) and appended after,
// sorted alphabetically, instead of being silently dropped the way a fixed
// `{ personal: 0, global: 0 }` accumulator object would drop it.
const KNOWN_SOURCE_ORDER = ['personal', 'fallback-doc', 'global'];

function formatBySource(bySource) {
  const knownKeys = KNOWN_SOURCE_ORDER.filter((source) => source in bySource);
  const extraKeys = Object.keys(bySource)
    .filter((source) => !KNOWN_SOURCE_ORDER.includes(source))
    .sort();
  return [...knownKeys, ...extraKeys].map((source) => `${source}=${bySource[source]}`).join(', ');
}

/**
 * Print (and return) an immediate/scheduled breakdown for an assembled
 * (not-yet-sent) batch of cascade email items — no provider call needed,
 * reads only what the caller already computed for each item (scheduledAt /
 * sendTimeSource, under whatever shape that caller's items happen to use).
 *
 * Single shared implementation for scripts/send-newsletter.mjs and
 * scripts/send-job-alerts.mjs (previously duplicated and divergent — the
 * newsletter copy's `bySource` accumulator was missing the 'fallback-doc' key
 * that the job-alerts copy had, so a 'fallback-doc' item's count would
 * silently vanish from the newsletter tally instead of being reported).
 * `bySource` here is built dynamically from whatever sources are actually
 * encountered, so no source — known or future — can ever be dropped that way.
 *
 * @param {Array<object>} items
 * @param {object} [options]
 * @param {(item: object) => string|null|undefined} [options.getScheduledAt] - default reads item.scheduledAt
 * @param {(item: object) => string|null|undefined} [options.getSource] - default reads item.sendTimeSource
 * @param {string} [options.indent] - leading indentation for the printed lines (default '')
 * @returns {{ immediate: number, scheduled: number, bySource: Record<string, number>, byHour: number[] }}
 */
export function logScheduleDistribution(items, {
  getScheduledAt = (item) => item?.scheduledAt,
  getSource = (item) => item?.sendTimeSource,
  indent = '',
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const bySource = {};
  const byHour = new Array(24).fill(0);
  let immediate = 0;

  for (const item of list) {
    const scheduledAt = getScheduledAt(item);
    if (!scheduledAt) { immediate += 1; continue; }
    const hour = new Date(scheduledAt).getUTCHours();
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) byHour[hour] += 1;
    const source = getSource(item);
    if (source) bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const scheduledTotal = list.length - immediate;
  console.log(`${indent}📅 Scheduled-send distribution: ${immediate} immediate, ${scheduledTotal} scheduled (${formatBySource(bySource)})`);
  if (scheduledTotal > 0) {
    const hourLine = byHour
      .map((count, hour) => (count > 0 ? `${String(hour).padStart(2, '0')}h:${count}` : null))
      .filter(Boolean)
      .join(', ');
    console.log(`${indent}   by UTC hour: ${hourLine}`);
  }

  return { immediate, scheduled: scheduledTotal, bySource, byHour };
}
