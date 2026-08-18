#!/usr/bin/env node

/**
 * report-send-hour-impact.mjs — READ-ONLY validation report for feature #3798
 * (per-user scheduled-send time personalization).
 *
 * Answers the goal: "does sending each subscriber's newsletter at their
 * personal preferred hour actually improve engagement, compared to the old
 * one-timestamp-for-everyone send?" Groups `campaign_deliveries` docs by
 * `send_time_source` (`personal` | `global` | absent — see below) and
 * compares open rate / click rate per group.
 *
 * `send_time_source` values (written by scripts/send-newsletter.mjs at send
 * time, see scripts/lib/send-schedule.mjs `resolveEffectivePreferredHour`):
 *   - 'personal' — this subscriber's own preferred_send_hour_utc was used
 *     (>= PREFERRED_SEND_MIN_EVENTS qualifying open/click events).
 *   - 'global'   — no personal signal yet; the site-wide aggregate hour
 *     (newsletter_subscribers/_meta_.global_preferred_send_hour_utc) was used.
 *   - absent/null — pre-feature send, or PER_USER_SEND_TIME=off, or neither a
 *     personal nor a global hour was available (immediate send, no
 *     scheduledAt at all). Reported as "immediate/pre-feature".
 *
 * One-off transactional sends (calculator/LAMal PDF reports, see
 * TRANSACTIONAL_CAMPAIGN_IDS below) are excluded entirely rather than
 * counted as "immediate/pre-feature": they fire instantly on a tool
 * request, never through send-newsletter.mjs/send-job-alerts.mjs, so
 * they're not a comparable pre-feature newsletter/job-alert baseline.
 *
 * Open/click detection mirrors scripts/lib/newsletter-ab-data.mjs (the
 * subject-line A/B report's loader): the canonical send-path delivery doc
 * (`campaign_deliveries/{campaignId}__{email}`, see
 * functions/src/lib/deliveryDocId.js) only gets `opened_at`/`clicked_at`
 * merged onto it directly for Resend (its webhook writes to the SAME doc id).
 * The other 4 webhook-tracked providers (Mailjet, Mailgun, Mailtrap,
 * Maileroo — Cloudflare has no engagement webhook at all) write their own
 * delivery doc with a DIFFERENT id, so relying on `opened_at`/`clicked_at` on
 * the canonical doc alone would silently under-count opens/clicks for those
 * 4 providers and skew the personal-vs-immediate comparison. This report
 * cross-checks against the `events` subcollection (open/click events, every
 * provider writes these) and ORs the two signals — same approach as the A/B
 * report, so this and that report can't disagree about what counts as "opened".
 *
 * DELIVERY TIME, NOT SEND TIME (#3798 Fase 4 instrument fix). The whole point
 * of this feature is that the provider delivers LATER than the moment we called
 * its API: `sent_at` is the API call, `scheduled_for` is when the message was
 * actually released (see scripts/send-newsletter.mjs persistSent /
 * scripts/send-job-alerts.mjs). Bucketing and windowing on `sent_at` therefore
 * measures the `personal` cohort — the only cohort that is systematically
 * delayed — against a shorter effective open window than `global` and
 * `immediate`, which go out at once. That confound has exactly the sign of the
 * negative result first observed on this feature, so this report anchors
 * everything to `scheduled_for ?? sent_at` instead, and additionally:
 *
 *   1. MATURATION — drops every delivery (in ALL groups alike) delivered more
 *      recently than `--maturity-hours` ago, so each cohort has had the same
 *      amount of time to be opened before it is counted.
 *   2. WINDOW ANCHORING — the pre/post split and the window floor compare
 *      against the effective delivery instant, not `sent_at`. The Firestore
 *      query still filters on `sent_at` (that is the indexed field), so it is
 *      widened by MAX_SCHEDULE_LOOKAHEAD_MS and the surplus is trimmed in
 *      aggregate() — otherwise a message sent just before the floor but
 *      delivered inside it would never be fetched.
 *   3. COVERAGE — counts how many deliveries in each group actually carry a
 *      non-null `scheduled_for`. A `personal` delivery whose cascade landed on
 *      a provider with no native scheduled-send (Mailjet v3.1, Mailtrap,
 *      Cloudflare — see functions/src/emailCascade.js) is labelled `personal`
 *      but went out immediately: it never received the treatment. Without this
 *      number the test measures a treatment of unknown intensity, so the
 *      report also prints a treated-only ("scheduled") comparison alongside
 *      the intent-to-treat one.
 *
 * Read-only: no Firestore writes, no emails sent. Exit code is always 0 (a
 * report, not a CI gate) — Firestore/index errors are logged and degrade the
 * output, they never fail the process.
 *
 * Usage:
 *   node scripts/report-send-hour-impact.mjs                    # last 30 days
 *   node scripts/report-send-hour-impact.mjs --days 60
 *   node scripts/report-send-hour-impact.mjs --since 2026-07-01  # pre/post split
 *   node scripts/report-send-hour-impact.mjs --maturity-hours 72
 *   node scripts/report-send-hour-impact.mjs --json
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT (optional).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { twoProportionTest } from '../services/newsletter-ab-stats.mjs';
import { MissingIndexError } from './lib/missing-index-error.mjs';

// #3798 Fix MEDIO #4: a fixed n<100 threshold flags plenty of large-but-close
// comparisons as "significant" and plenty of small-but-decisive ones as noise.
// Reuse the same two-proportion z-test the subject-line A/B report already
// relies on (services/newsletter-ab-stats.mjs) — single source of truth for
// "is this rate difference real" across both reports.
const SIGNIFICANCE_ALPHA = 0.05;
const BATCH_PAGE_SIZE = 200;
const SUBCOLLECTION_CONCURRENCY = 20;
const DEFAULT_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Default maturation window (#3798 Fase 4). A delivery released less than this
 * long ago has not had a fair chance to be opened yet, so counting it drags its
 * cohort's open rate down purely as a function of recency. 48h is well past the
 * bulk of newsletter opens while still discarding only ~2 of a 20-day window.
 */
export const DEFAULT_MATURITY_HOURS = 48;

/**
 * How far past the logical window floor the Firestore query has to reach.
 * The query can only filter on `sent_at` (the indexed field) while the report
 * windows on `scheduled_for ?? sent_at`, and scheduled_for is always >= sent_at
 * — so a message sent up to one full lookahead before the floor can still be
 * delivered inside it. 3 days matches the tightest real cap in the cascade
 * (Mailgun/Resend `maxLookaheadMs: 3 * DAY_MS`, functions/src/emailCascade.js)
 * and comfortably covers what computeScheduledSendAt actually emits (today or
 * tomorrow at the preferred hour, i.e. < ~24h). Over-fetching here is free:
 * aggregate() trims anything that lands before the floor and reports the count.
 */
export const MAX_SCHEDULE_LOOKAHEAD_MS = 3 * DAY_MS;

/**
 * Below this share of `personal` deliveries carrying a real `scheduled_for`,
 * the `personal` cohort is substantially diluted with untreated sends and its
 * intent-to-treat rate should not be read as the feature's effect.
 */
export const LOW_COVERAGE_WARN_RATIO = 0.8;

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/**
 * `--days` is a lookback window, so it must be a finite positive number.
 * Bug this guards against: `Number(raw) || DEFAULT_DAYS` (the previous
 * implementation) only falls back to the default for `NaN`/`0` — a negative
 * value like `--days -5` is truthy and survives untouched, which then makes
 * `cutoffDate = now - DAYS*24h` land 5 days in the FUTURE. The query still
 * "succeeds" (0 rows, since nothing is dated in the future), so the report
 * silently prints "Nothing to report" instead of erroring on the bad input.
 * @param {string|null} raw - the raw --days value, or null when the flag was omitted
 * @returns {{ days: number, warning: string|null }}
 */
export function parseDaysArg(raw) {
  if (raw === null) return { days: DEFAULT_DAYS, warning: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { days: DEFAULT_DAYS, warning: `⚠️  --days "${raw}" must be a positive number — using the default (${DEFAULT_DAYS}).` };
  }
  return { days: n, warning: null };
}

/**
 * Strict YYYY-MM-DD parse for `--since`. Rejects malformed strings AND
 * calendar-invalid-but-JS-Date-"helpfully"-rolled-over dates: plain
 * `new Date("2026-02-30T00:00:00.000Z")` silently returns 2026-03-02 instead
 * of throwing, which would silently shift the pre/post split boundary by
 * however many days the invalid date overflowed by, with no warning at all
 * (the previous implementation only checked `Number.isNaN(parsed.getTime())`,
 * which a rolled-over date never triggers). This round-trips the parsed
 * UTC components against the input and rejects on mismatch instead.
 * @param {string|null} raw
 * @returns {{ date: Date|null, warning: string|null }}
 */
export function parseSinceArg(raw) {
  if (!raw) return { date: null, warning: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const invalidWarning = `⚠️  --since "${raw}" is not a valid YYYY-MM-DD date — ignoring the pre/post split.`;
  if (!m) return { date: null, warning: invalidWarning };
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  const [, y, mo, d] = m;
  const roundTrips = !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === Number(y)
    && parsed.getUTCMonth() + 1 === Number(mo)
    && parsed.getUTCDate() === Number(d);
  if (!roundTrips) return { date: null, warning: invalidWarning };
  return { date: parsed, warning: null };
}

/**
 * Firestore query floor (sent_at/timestamp >= this). Exported/pure so the
 * "vanishing baseline" regression (#3798, ALTO #1) has a test: a naive
 * `sinceDate < cutoffDate ? sinceDate : cutoffDate` floors the query AT
 * sinceDate once `now - days` drifts past it, which can never fetch anything
 * the aggregator buckets as "before" sinceDate — the before-segment goes
 * permanently empty from that day forward. The "before" segment is a fixed
 * historical baseline, not a rolling window, so anchor its floor to
 * (sinceDate - days) instead, giving it a stable days-day sample no matter how
 * far "now" advances.
 * @param {Date} now
 * @param {number} days
 * @param {Date|null} sinceDate
 * @returns {Date}
 */
export function computeQueryFloor(now, days, sinceDate) {
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  if (!sinceDate) return cutoffDate;
  const baselineFloor = new Date(sinceDate.getTime() - days * 24 * 60 * 60 * 1000);
  return baselineFloor < cutoffDate ? baselineFloor : cutoffDate;
}

/**
 * `--maturity-hours` (#3798 Fase 4). Unlike `--days` this DOES accept 0, which
 * explicitly disables the maturation filter (useful to reproduce the old,
 * confounded numbers side by side). Negative and non-numeric input falls back
 * to the default rather than silently producing a cutoff in the future, which
 * would drop every delivery and print empty tables.
 * @param {string|null} raw
 * @returns {{ hours: number, warning: string|null }}
 */
export function parseMaturityHoursArg(raw) {
  if (raw === null || raw === undefined) return { hours: DEFAULT_MATURITY_HOURS, warning: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { hours: DEFAULT_MATURITY_HOURS, warning: `⚠️  --maturity-hours "${raw}" must be >= 0 — using the default (${DEFAULT_MATURITY_HOURS}).` };
  }
  return { hours: n, warning: null };
}

/**
 * Instant after which a delivery is too fresh to be counted. `null` when the
 * filter is disabled (hours === 0), which callers must treat as "keep
 * everything" rather than as "keep nothing".
 * @param {Date} now
 * @param {number} hours
 * @returns {Date|null}
 */
export function computeMaturityCutoff(now, hours) {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(now.getTime() - hours * HOUR_MS);
}

/**
 * Firestore `sent_at` floor for a given logical (delivery-time) floor.
 * See MAX_SCHEDULE_LOOKAHEAD_MS: the query is on send time, the window is on
 * delivery time, so the query has to start one lookahead earlier or it drops
 * exactly the scheduled deliveries this report exists to measure.
 * @param {Date} windowFloor
 * @returns {Date}
 */
export function computeFetchFloor(windowFloor) {
  return new Date(windowFloor.getTime() - MAX_SCHEDULE_LOOKAHEAD_MS);
}

/**
 * When the message was actually released by the provider: the cascade's
 * authoritative `scheduled_for` when it scheduled, else the moment of the API
 * call. Returns null only when neither field is usable.
 *
 * Guards against a `scheduled_for` that predates `sent_at` (a provider echoing
 * back a clamped/immediate time, or clock skew): delivery can never precede the
 * API call, and letting an earlier value through would pull a delivery into the
 * wrong side of the pre/post split.
 * @param {object} data - raw Firestore delivery doc data
 * @returns {Date|null}
 */
export function effectiveDeliveryDate(data) {
  if (!data?.sent_at) return null;
  const sentAt = toDateSafe(data.sent_at);
  if (Number.isNaN(sentAt.getTime())) return null;
  if (!data.scheduled_for) return sentAt;
  const scheduledFor = toDateSafe(data.scheduled_for);
  if (Number.isNaN(scheduledFor.getTime())) return sentAt;
  return scheduledFor > sentAt ? scheduledFor : sentAt;
}

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { admin: a, db: a.firestore() };
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Mirrors functions/src/lib/deliveryDocId.js buildDeliveryDocId (kept in sync by hand — read-only report, no import to avoid a functions/ → scripts/ runtime dependency). */
export function buildCanonicalDeliveryDocId(campaignId, email) {
  return `${campaignId}__${normalizeEmail(email)}`.replace(/[^a-z0-9@._-]+/gi, '-');
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Shared loader for a timestamp-filtered collectionGroup query, with a
 * fallback for when the collectionGroup composite index doesn't exist yet:
 * page through newsletter_subscribers/* and read each one's `group`
 * subcollection directly (batched: subscribers paginated BATCH_PAGE_SIZE at a
 * time, each page's subcollection reads run with bounded concurrency).
 *
 * campaign_deliveries and events used to have two structurally-identical
 * copies of this collectionGroup → MissingIndexError → per-subscriber-fallback
 * flow (one per collection); collapsed into this one parametrized loader —
 * see loadDeliveries/loadEvents below for the thin per-collection wrappers.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Date} cutoffDate
 * @param {object} options
 * @param {string} options.group - subcollection name (e.g. 'campaign_deliveries', 'events')
 * @param {string} options.timestampField - field the cutoff is compared against (e.g. 'sent_at', 'timestamp')
 * @param {boolean} [options.includeIndexLinkWarning] - also print the "create the index" hint
 *   on fallback (campaign_deliveries only — its MissingIndexError carries the original
 *   Firestore error with the console index-creation link; events' does not warrant it here)
 * @returns {Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[], usedFallback: boolean }>}
 */
async function loadCollectionGroupWithFallback(db, cutoffDate, { group, timestampField, includeIndexLinkWarning = false }) {
  async function queryCollectionGroup() {
    try {
      const snap = await db.collectionGroup(group).where(timestampField, '>=', cutoffDate).get();
      return snap.docs;
    } catch (e) {
      if (String(e?.message || '').includes('index')) throw new MissingIndexError(group, timestampField, e);
      throw e;
    }
  }

  async function queryPerSubscriber() {
    const docs = [];
    let lastDoc = null;
    for (;;) {
      let q = db.collection('newsletter_subscribers').orderBy('__name__').limit(BATCH_PAGE_SIZE);
      if (lastDoc) q = q.startAfter(lastDoc);
      const page = await q.get();
      if (page.empty) break;

      const subscriberRefs = page.docs.filter((d) => d.id !== '_meta_').map((d) => d.ref);
      const subSnaps = await mapWithConcurrency(subscriberRefs, SUBCOLLECTION_CONCURRENCY, (ref) =>
        ref.collection(group).where(timestampField, '>=', cutoffDate).get(),
      );
      for (const snap of subSnaps) docs.push(...snap.docs);

      lastDoc = page.docs[page.docs.length - 1];
      if (page.docs.length < BATCH_PAGE_SIZE) break;
    }
    return docs;
  }

  try {
    return { docs: await queryCollectionGroup(), usedFallback: false };
  } catch (e) {
    if (e instanceof MissingIndexError) {
      console.warn(`⚠️  ${e.message} — falling back to per-subscriber subcollection reads (slower).`);
      if (includeIndexLinkWarning) {
        console.warn(`   To speed this up, create the index via the link in the original error:\n   ${e.original?.message || ''}`);
      }
      return { docs: await queryPerSubscriber(), usedFallback: true };
    }
    throw e;
  }
}

// ── Data loading: canonical delivery docs (denominator + send_time_source) ──

async function loadDeliveries(db, cutoffDate) {
  return loadCollectionGroupWithFallback(db, cutoffDate, {
    group: 'campaign_deliveries',
    timestampField: 'sent_at',
    includeIndexLinkWarning: true,
  });
}

// ── Data loading: open/click events (numerator, cross-provider) ─────────────

async function loadEvents(db, cutoffDate) {
  const { docs } = await loadCollectionGroupWithFallback(db, cutoffDate, {
    group: 'events',
    timestampField: 'timestamp',
  });
  return docs;
}

// ── Aggregation ──────────────────────────────────────────────────────────

export const IMMEDIATE_LABEL = 'immediate/pre-feature';
export const GROUP_ORDER = ['personal', 'global', IMMEDIATE_LABEL];

/**
 * One-off transactional sends (see functions/src/sendCalculatorReport.js
 * ALLOWED_SOURCES) tag their Resend delivery with a real, non-colliding
 * campaign_id — so they write a regular campaign_deliveries doc — but they
 * fire instantly on a tool request, never through
 * scripts/send-newsletter.mjs/send-job-alerts.mjs, so they structurally can
 * never carry a send_time_source. Left alone they'd fall into
 * IMMEDIATE_LABEL and dilute that baseline with traffic that isn't a
 * pre-feature/opted-out newsletter or job-alert send (issue #4853). Kept in
 * sync by hand — same read-only-report tradeoff as
 * buildCanonicalDeliveryDocId above.
 */
export const TRANSACTIONAL_CAMPAIGN_IDS = new Set(['calculator_paywall', 'lamal_ssn_tool']);

/**
 * `scheduled*` are the treated-only sub-counts (#3798 Fase 4, coverage): the
 * subset of this cell's deliveries that carry a non-null `scheduled_for`, i.e.
 * that the provider genuinely held back until the chosen hour. Kept as sub-
 * counts of the same cell rather than as separate groups so the intent-to-treat
 * numbers stay exactly what they were and the treated-only view is a strict
 * refinement of them, never a different denominator elsewhere.
 */
export function emptyCell() {
  return { deliveries: 0, opens: 0, clicks: 0, scheduled: 0, scheduledOpens: 0, scheduledClicks: 0 };
}

/**
 * Project a cell down to its treated-only subset, in the shape comparisonLine
 * and formatSegmentTable already consume. Tolerates cells built before the
 * `scheduled*` fields existed (they read as 0, i.e. "nothing treated").
 * @param {{deliveries:number,opens:number,clicks:number,scheduled?:number,scheduledOpens?:number,scheduledClicks?:number}} cell
 */
export function treatedCell(cell) {
  return {
    deliveries: cell?.scheduled ?? 0,
    opens: cell?.scheduledOpens ?? 0,
    clicks: cell?.scheduledClicks ?? 0,
  };
}

export function newSegment() {
  const cells = {};
  for (const g of GROUP_ORDER) cells[g] = emptyCell();
  return cells;
}

export const pct = (n, d) => (d > 0 ? (100 * n) / d : 0);

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} deliveryDocs
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} eventDocs
 * @param {Date|null} sinceDate - when set, returns { before, after } segments; else { combined }
 */
function toDateSafe(v) {
  return typeof v?.toDate === 'function' ? v.toDate() : new Date(v);
}

// Map<string, Date[]> instead of Set<string> (#3798 edge case): a key only
// tells us an open/click ever happened for that campaign/alert::email or
// message_id — crediting a delivery also needs to know WHEN, so it can require
// occurred >= sent (see hasEventAtOrAfter below).
function addEventTime(map, key, time) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(time);
}

function hasEventAtOrAfter(map, keys, sentAt) {
  for (const k of keys) {
    const times = k && map.get(k);
    if (times && times.some((t) => t >= sentAt)) return true;
  }
  return false;
}

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} deliveryDocs
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} eventDocs
 * @param {Date|null} sinceDate
 * @param {object} [options]
 * @param {Date|null} [options.maturityCutoff] - drop deliveries RELEASED after this
 *   instant, in every group alike (#3798 Fase 4). null/omitted disables the filter.
 * @param {Date|null} [options.windowFloor] - drop deliveries RELEASED before this
 *   instant. Trims the MAX_SCHEDULE_LOOKAHEAD_MS over-fetch computeFetchFloor adds;
 *   null/omitted keeps everything that was fetched.
 */
export function aggregate(deliveryDocs, eventDocs, sinceDate, { maturityCutoff = null, windowFloor = null } = {}) {
  // Newsletter events carry campaign_id; job-alert events (job_alert_subscribers
  // .../events) carry alert_id instead — collectionGroup('events') pulls from
  // BOTH collections since they share the subcollection name, so accept either
  // as the send-side identifier.
  const openedTimes = new Map();
  const clickedTimes = new Map();
  for (const doc of eventDocs) {
    const d = doc.data();
    const groupId = d?.campaign_id || d?.alert_id;
    if (!d || !groupId) continue;
    if (d.event_type !== 'open' && d.event_type !== 'click') continue;
    const email = normalizeEmail(d.email || doc.ref.parent?.parent?.id || '');
    const time = toDateSafe(d.timestamp);
    const key = `${groupId}::${email}`;
    const msgKey = d.message_id ? `msg::${String(d.message_id)}` : null;
    const map = d.event_type === 'open' ? openedTimes : clickedTimes;
    if (email) addEventTime(map, key, time);
    if (msgKey) addEventTime(map, msgKey, time);
  }

  const segments = sinceDate ? { before: newSegment(), after: newSegment() } : { combined: newSegment() };
  let droppedNonCanonical = 0;
  let droppedTransactional = 0;
  let droppedOperatorVerification = 0;
  let droppedImmature = 0;
  let droppedBeforeWindow = 0;

  for (const doc of deliveryDocs) {
    const d = doc.data();
    if (!d || !d.sent_at) continue; // only count real sends, not webhook-only stub docs
    // Operator QA sends (send-newsletter.mjs --test / send-job-alerts.mjs
    // ALLOWED_EMAILS, #3798) aren't real subscriber traffic and typically lack a
    // real campaign/alert id — counting them would contaminate the
    // immediate/pre-feature bucket with artificial deliveries+engagement.
    if (d.is_operator_verification) { droppedOperatorVerification++; continue; }
    const email = normalizeEmail(d.email || doc.ref.parent?.parent?.id || '');
    if (!email) continue;
    const campaignId = d.campaign_id || 'unknown';
    // Exclude one-off transactional sends entirely — they can never carry a
    // send_time_source and would otherwise dilute IMMEDIATE_LABEL (#4853).
    if (TRANSACTIONAL_CAMPAIGN_IDS.has(campaignId)) { droppedTransactional++; continue; }
    // Keep ONLY the canonical send-path doc (same filter as the A/B report) —
    // non-Resend webhooks write a second doc with a different id; counting
    // both would double-count deliveries.
    if (doc.id !== buildCanonicalDeliveryDocId(campaignId, email)) { droppedNonCanonical++; continue; }

    const groupKey = (d.send_time_source === 'personal' || d.send_time_source === 'global')
      ? d.send_time_source
      : IMMEDIATE_LABEL;

    const sentAt = toDateSafe(d.sent_at);
    // #3798 Fase 4: window, split and maturity all key off the moment the
    // provider RELEASED the message, not the moment we called its API — see
    // the module docblock. For an unscheduled send the two are the same
    // instant, so the immediate/global cohorts behave exactly as before.
    const deliveredAt = effectiveDeliveryDate(d) ?? sentAt;
    if (windowFloor && deliveredAt < windowFloor) { droppedBeforeWindow++; continue; }
    if (maturityCutoff && deliveredAt > maturityCutoff) { droppedImmature++; continue; }

    const segmentKey = sinceDate ? (deliveredAt < sinceDate ? 'before' : 'after') : 'combined';
    const cell = segments[segmentKey][groupKey];
    // Coverage (#3798 Fase 4): did this delivery actually get held back? A
    // `personal`-labelled send that fell through to a provider with no native
    // scheduled-send went out immediately and never received the treatment.
    const wasScheduled = Boolean(d.scheduled_for);

    cell.deliveries++;
    if (wasScheduled) cell.scheduled++;

    const key = `${campaignId}::${email}`;
    const msgKey = d.message_id ? `msg::${String(d.message_id)}` : null;
    // Edge case (#3798): an open/click can carry a timestamp before this
    // delivery's sent_at when a send lacking a real campaign/alert id (tag
    // 'unknown' — confirmation emails, ad-hoc sends) collides with an earlier
    // send to the same address on the shared 'unknown'-keyed canonical doc, so
    // sent_at gets overwritten and orphans the older event. Require the event
    // (own-doc field or events-collection match) to have occurred at or after
    // sent_at before crediting it to this delivery — strict, no tolerance
    // window, since the corrected canonical-doc-only data shows zero genuine
    // sub-10-second cases (see docs/AGENTS-HISTORY.md's #3798 investigation).
    const openedAtDate = d.opened_at ? toDateSafe(d.opened_at) : null;
    const clickedAtDate = d.clicked_at ? toDateSafe(d.clicked_at) : null;
    const opened = (openedAtDate && openedAtDate >= sentAt) || hasEventAtOrAfter(openedTimes, [key, msgKey], sentAt);
    const clicked = (clickedAtDate && clickedAtDate >= sentAt) || hasEventAtOrAfter(clickedTimes, [key, msgKey], sentAt);
    if (opened) cell.opens++;
    if (clicked) cell.clicks++;
    if (wasScheduled && opened) cell.scheduledOpens++;
    if (wasScheduled && clicked) cell.scheduledClicks++;
  }

  return {
    segments,
    droppedNonCanonical,
    droppedTransactional,
    droppedOperatorVerification,
    droppedImmature,
    droppedBeforeWindow,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────

export function formatSegmentTable(title, cells) {
  const lines = [];
  lines.push(title);
  lines.push('  group                    deliveries    opens  open-rate    clicks  click-rate   sched%');
  lines.push('  ------------------------ ----------  -------  ---------  --------  ----------  -------');
  for (const g of GROUP_ORDER) {
    const c = cells[g];
    const openRate = pct(c.opens, c.deliveries);
    const clickRate = pct(c.clicks, c.deliveries);
    // sched% = coverage (#3798 Fase 4): the share of this group's deliveries
    // the provider actually held back until the chosen hour. For `global` and
    // `personal` it should be near 100%; anything lower means the cascade fell
    // through to a provider without native scheduled-send and those rows are
    // untreated. `immediate/pre-feature` is 0% by definition.
    const coverage = pct(c.scheduled ?? 0, c.deliveries);
    // No per-row significance note: "significant" is a property of a
    // COMPARISON between two groups, not of a single group's sample size —
    // see comparisonLine below, which runs the real test against a baseline.
    lines.push(
      `  ${g.padEnd(24)} ${String(c.deliveries).padStart(10)}  ${String(c.opens).padStart(7)}  ${openRate.toFixed(1).padStart(8)}%  ${String(c.clicks).padStart(8)}  ${clickRate.toFixed(1).padStart(9)}%  ${coverage.toFixed(1).padStart(6)}%`,
    );
  }
  return lines.join('\n');
}

/**
 * Human-readable treatment-coverage verdict for a segment (#3798 Fase 4,
 * point 3). Answers "how much of the `personal` cohort actually received the
 * treatment?" — without it, the personal-vs-global test compares a treatment
 * of unknown intensity against a control and any null result is unreadable.
 * @param {Record<string, {deliveries:number, scheduled?:number}>} cells
 * @returns {string}
 */
export function formatCoverageNote(cells) {
  const personal = cells?.personal ?? emptyCell();
  const scheduled = personal.scheduled ?? 0;
  if (personal.deliveries === 0) return '  ℹ️  treatment coverage: no `personal` deliveries in this segment.';
  const ratio = scheduled / personal.deliveries;
  const base = `  ℹ️  treatment coverage: ${scheduled}/${personal.deliveries} (${(100 * ratio).toFixed(1)}%) of \`personal\` deliveries carry a real scheduled_for`;
  if (ratio >= LOW_COVERAGE_WARN_RATIO) return `${base}.`;
  return `${base}.\n  ⚠️  Below ${(100 * LOW_COVERAGE_WARN_RATIO).toFixed(0)}% — the \`personal\` row is diluted with sends that went out immediately (cascade fell through to a provider without native scheduled-send). Read the "scheduled only" comparison below, not the row above.`;
}

export function comparisonLine(label, cellA, cellB, nameA, nameB) {
  if (cellA.deliveries === 0 || cellB.deliveries === 0) {
    return `${label}: insufficient data (${nameA}=${cellA.deliveries}, ${nameB}=${cellB.deliveries} deliveries)`;
  }
  const rateA = pct(cellA.opens, cellA.deliveries);
  const rateB = pct(cellB.opens, cellB.deliveries);
  const openDelta = rateA - rateB;
  const clickRateA = pct(cellA.clicks, cellA.deliveries);
  const clickRateB = pct(cellB.clicks, cellB.deliveries);
  const clickDelta = clickRateA - clickRateB;
  // Real two-proportion z-test on the open rate (primary metric) instead of a
  // fixed n<100 threshold: a 500-vs-500 comparison with near-identical rates
  // is genuinely not significant, while a 60-vs-60 comparison with a huge gap
  // can be — sample size alone answers neither question.
  const test = twoProportionTest(
    { sends: cellA.deliveries, opens: cellA.opens },
    { sends: cellB.deliveries, opens: cellB.opens },
  );
  const sigFlag = test ? ` [${test.pValue < SIGNIFICANCE_ALPHA ? 'significant' : 'not significant'}, p=${test.pValue.toFixed(3)}]` : '';
  const sign = (n) => (n >= 0 ? '+' : '');
  return `${label}: open rate ${sign(openDelta)}${openDelta.toFixed(1)}pp (${rateA.toFixed(1)}% vs ${rateB.toFixed(1)}%), click rate ${sign(clickDelta)}${clickDelta.toFixed(1)}pp (${clickRateA.toFixed(1)}% vs ${clickRateB.toFixed(1)}%)${sigFlag}`;
}

function printSegment(name, cells) {
  console.log(`\n${formatSegmentTable(name, cells)}\n`);
  console.log(comparisonLine('  → personal vs immediate', cells.personal, cells[IMMEDIATE_LABEL], 'personal', 'immediate'));
  console.log(comparisonLine('  → global vs immediate  ', cells.global, cells[IMMEDIATE_LABEL], 'global', 'immediate'));
  console.log(comparisonLine('  → personal vs global   ', cells.personal, cells.global, 'personal', 'global'));
  console.log('');
  console.log(formatCoverageNote(cells));
  // Treated-only (per-protocol) view: restricted to deliveries that really
  // carried a scheduled_for on BOTH sides, so the contrast is "held back until
  // the personal hour" vs "held back until the global hour" rather than a mix
  // of treated and untreated rows on the personal side.
  console.log(comparisonLine('  → personal vs global   (scheduled only)', treatedCell(cells.personal), treatedCell(cells.global), 'personal', 'global'));
}

function printHelp() {
  console.log(`
report-send-hour-impact.mjs — READ-ONLY validation report for feature #3798
(per-user scheduled-send time personalization). Compares open/click rate
between subscribers sent at their personal preferred hour, the site-wide
global hour, and the pre-feature immediate send.

Usage:
  node scripts/report-send-hour-impact.mjs                    # last 30 days
  node scripts/report-send-hour-impact.mjs --days 60
  node scripts/report-send-hour-impact.mjs --since 2026-07-01  # pre/post split
  node scripts/report-send-hour-impact.mjs --json

Options:
  --days <N>       Lookback window in days. Default: 30. Must be > 0. When
                    --since is set, also sizes the "before" baseline: it
                    covers the N days immediately preceding --since, anchored
                    to --since rather than to "now" (see --since).
  --since <DATE>   YYYY-MM-DD. Splits the window into before/on-after this date.
                    The "before" segment is a FIXED historical baseline (--days
                    before --since) — it does not slide forward with "now", so
                    it stays populated indefinitely instead of emptying out
                    once "now - days" runs past --since (#3798, ALTO #1).
  --maturity-hours <N>
                   Drop deliveries RELEASED less than N hours ago, in every
                    group alike, so each cohort has had the same chance to be
                    opened. Default: ${DEFAULT_MATURITY_HOURS}. 0 disables the filter and
                    reproduces the old (confounded) numbers.
  --json           Emit a single JSON object on stdout instead of the table.
  --help, -h       Show this help.

All windowing keys off \`scheduled_for ?? sent_at\` (when the provider actually
released the message), not \`sent_at\` (when we called its API) — see the module
docblock for why measuring a deliberately-delayed cohort on send time biases it.

Read-only: no Firestore writes, no emails sent. Exit code is always 0.
Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT (optional).
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const JSON_OUT = argv.includes('--json');
  const { days: DAYS, warning: daysWarning } = parseDaysArg(argValue(argv, '--days'));
  const SINCE_RAW = argValue(argv, '--since');
  const { date: SINCE_DATE, warning: sinceWarning } = parseSinceArg(SINCE_RAW);
  const { hours: MATURITY_HOURS, warning: maturityWarning } = parseMaturityHoursArg(argValue(argv, '--maturity-hours'));
  // console.warn → stderr, never stdout, so these are safe to print
  // unconditionally without corrupting `--json`'s stdout output.
  if (daysWarning) console.warn(daysWarning);
  if (sinceWarning) console.warn(sinceWarning);
  if (maturityWarning) console.warn(maturityWarning);
  if (SINCE_DATE && SINCE_DATE.getTime() > Date.now()) {
    console.warn(`⚠️  --since "${SINCE_RAW}" is in the future — the "after" segment will be empty.`);
  }

  const now = new Date();
  // windowFloor is the logical floor in DELIVERY time; fetchFloor is the wider
  // `sent_at` floor the Firestore query needs to reach it (#3798 Fase 4).
  const windowFloor = computeQueryFloor(now, DAYS, SINCE_DATE);
  const fetchFloor = computeFetchFloor(windowFloor);
  const maturityCutoff = computeMaturityCutoff(now, MATURITY_HOURS);
  const baselineFloor = SINCE_DATE ? new Date(SINCE_DATE.getTime() - DAYS * DAY_MS) : null;

  if (!JSON_OUT) {
    console.log(`\n📬 Send-hour personalization impact report (feature #3798)`);
    console.log(`   Window: last ${DAYS} day(s) — delivered since ${windowFloor.toISOString()}`);
    if (SINCE_DATE) console.log(`   Pre/post split at: ${SINCE_DATE.toISOString()} (before-baseline anchored to ${baselineFloor.toISOString()})`);
    console.log(`   Keyed on delivery time (scheduled_for ?? sent_at), not send time; sent_at fetched from ${fetchFloor.toISOString()}.`);
    console.log(maturityCutoff
      ? `   Maturation: ${MATURITY_HOURS}h — deliveries released after ${maturityCutoff.toISOString()} are excluded from ALL groups.`
      : '   Maturation: DISABLED (--maturity-hours 0) — fresh deliveries are counted, cohorts are not comparable.');
    console.log('   Read-only — no Firestore writes, no emails sent.\n');
  }

  const { db } = await initFirebase();

  const [{ docs: deliveryDocs, usedFallback }, eventDocs] = await Promise.all([
    loadDeliveries(db, fetchFloor).catch((e) => {
      console.error(`❌ Failed to load campaign_deliveries: ${e?.message || e}`);
      return { docs: [], usedFallback: false };
    }),
    loadEvents(db, fetchFloor).catch((e) => {
      console.error(`❌ Failed to load events: ${e?.message || e}`);
      return [];
    }),
  ]);

  if (deliveryDocs.length === 0) {
    // JSON mode must emit ONLY valid JSON on stdout (a consumer piping this
    // into `jq`/JSON.parse would otherwise choke on the human-readable
    // warning line printed ahead of it — this used to print both).
    if (JSON_OUT) {
      console.log(JSON.stringify({ deliveries: 0 }, null, 2));
    } else {
      console.log('⚠️  No campaign_deliveries found in this window. Nothing to report.');
    }
    process.exit(0);
  }

  const {
    segments,
    droppedNonCanonical,
    droppedTransactional,
    droppedOperatorVerification,
    droppedImmature,
    droppedBeforeWindow,
  } = aggregate(deliveryDocs, eventDocs, SINCE_DATE, { maturityCutoff, windowFloor });

  if (JSON_OUT) {
    console.log(JSON.stringify({
      generatedAt: now.toISOString(),
      windowDays: DAYS,
      since: SINCE_DATE ? SINCE_DATE.toISOString() : null,
      windowFloor: windowFloor.toISOString(),
      fetchFloor: fetchFloor.toISOString(),
      maturityHours: MATURITY_HOURS,
      maturityCutoff: maturityCutoff ? maturityCutoff.toISOString() : null,
      usedFallbackQuery: usedFallback,
      droppedNonCanonicalDocs: droppedNonCanonical,
      droppedTransactionalDocs: droppedTransactional,
      droppedOperatorVerificationDocs: droppedOperatorVerification,
      droppedImmatureDocs: droppedImmature,
      droppedBeforeWindowDocs: droppedBeforeWindow,
      segments,
    }, null, 2));
    return;
  }

  if (SINCE_DATE) {
    printSegment(`Before ${SINCE_RAW}`, segments.before);
    printSegment(`On/after ${SINCE_RAW}`, segments.after);
  } else {
    printSegment(`Last ${DAYS} day(s)`, segments.combined);
  }

  console.log(`\n(Fallback per-subscriber query used: ${usedFallback ? 'yes' : 'no'}; ${droppedNonCanonical} non-canonical duplicate delivery doc(s) ignored; ${droppedTransactional} transactional (calculator/LAMal) delivery doc(s) excluded; ${droppedOperatorVerification} operator-verification delivery doc(s) excluded; ${droppedImmature} delivery doc(s) excluded as too fresh (< ${MATURITY_HOURS}h since release); ${droppedBeforeWindow} delivery doc(s) excluded as delivered before the window floor.)\n`);
}

// Run only when invoked directly (node scripts/report-send-hour-impact.mjs);
// the pure aggregation/parsing functions above stay importable for tests
// without triggering a live Firestore connection attempt.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    // Report, not a gate: log the failure but never fail the process.
    console.error('❌ Report failed to complete:', err?.message || err);
    process.exit(0);
  });
}
