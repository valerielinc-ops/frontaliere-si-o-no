/**
 * Per-alert sent-job de-duplication.
 *
 * Root cause of "I keep receiving the same jobs" (issue #2993): the job-alert
 * sender had NO memory of which jobs it already emailed to a given alert. Job
 * eligibility is a rolling 24h `crawledAt` window — so any job that is
 * re-crawled (its `crawledAt` refreshes) or simply lingers inside that window
 * across two daily runs gets re-scored and re-sent. The same top-scored job
 * (e.g. "Ingegnere di software senior presso Duferco") therefore headlines the
 * alert email day after day.
 *
 * Fix: persist a `sentJobIds` map `{ jobKey: sentAtMs }` on the alert doc. On
 * each run we exclude jobs already sent within `DEDUP_WINDOW_MS`, so the email
 * surfaces only jobs the subscriber has NOT seen yet. When nothing new matches,
 * the send loop skips the email entirely instead of re-sending stale offers.
 *
 * The map is pruned to the dedup window and capped (`SENT_JOBS_CAP`) so the
 * alert doc can never grow unbounded (Firestore 1 MiB doc limit).
 *
 * Pure (no Firestore / IO) so it can be unit-tested directly — see
 * tests/alert-sent-jobs.test.ts.
 */

import { extractStableJobId, hasUsableJobId } from './job-match-key.mjs';

// How long a job stays "already sent" for an alert. A job re-surfacing after
// this window (still genuinely open) is allowed through again — rare, and
// preferable to permanently hiding a still-relevant listing.
export const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// A claim that never reaches the provider-attempt marker is recoverable after
// a dead worker. Once the marker is written, the state becomes `ambiguous` and
// remains retry-blocking until a provider result or reconciliation resolves it.
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// A deferred job may be retried twice; the third deferred outcome is terminal
// so an unresolved lookup or a permanently capped backlog cannot loop forever.
export const DEFERRED_MAX_ATTEMPTS = 3;

// Hard cap on retained entries per alert (most-recent kept). 500 × ~40 bytes ≈
// 20 KB, comfortably under the Firestore doc limit even with the rest of the
// alert config.
export const SENT_JOBS_CAP = 500;

/**
 * Durable sender outcomes kept beside `sentJobIds` on the alert document.
 *
 * `sentJobIds` is the compact, successful-delivery view used by the existing
 * digest.  It is not enough for an immediate sender: a provider can accept a
 * message while the process is still before the writeback, and two workflow
 * runs can both observe the same empty map.  The immediate sender therefore
 * writes a small per-job ledger before handing the email to the provider.
 *
 * `claimed` is retry-blocking only for CLAIM_TTL_MS: it is the recoverable
 * reservation before the provider boundary. The sender then moves it to
 * `ambiguous` before the provider call; if the final writeback cannot prove
 * what happened, that durable state stays reserved instead of being sent
 * again. `deferred` is observable backlog work and remains eligible for a
 * later run until `DEFERRED_MAX_ATTEMPTS`; `deferred-exhausted` is terminal and
 * retry-blocking. `accepted` is retained only as a legacy read shape; the
 * current finalizer removes it after updating `sentJobIds`.
 */
export const DELIVERY_STATES = Object.freeze({
  CLAIMED: 'claimed',
  AMBIGUOUS: 'ambiguous',
  DEFERRED: 'deferred',
  DEFERRED_EXHAUSTED: 'deferred-exhausted',
  FAILED: 'failed',
});

const DELIVERY_STATE_SET = new Set([...Object.values(DELIVERY_STATES), 'accepted']);

function coerceMillis(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Stable de-dup key for a job. Prefers the crawler-assigned `id` (present on
 * every job in data/jobs.json and what the pinned-alert matcher already keys
 * on), then the URL-derived stable id, then the slug. Returns '' when a job has
 * no usable identifier (caller should treat it as non-dedupable).
 *
 * @param {object} job
 * @returns {string}
 */
export function jobDedupKey(job) {
  if (!job) return '';
  if (hasUsableJobId(job)) return String(job.id);
  const fromUrl = extractStableJobId(job.url || '');
  if (fromUrl) return fromUrl;
  return String(job.slug || '');
}

/**
 * Coerce a stored `sentJobIds` value into a plain `{ key: ms }` object,
 * tolerating legacy/absent shapes (undefined, array, Firestore map).
 *
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function normalizeSentMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const ms = typeof v === 'number'
      ? v
      : (v && typeof v.toMillis === 'function' ? v.toMillis() : Number(new Date(v).getTime()));
    if (k && Number.isFinite(ms)) out[String(k)] = ms;
  }
  return out;
}

/**
 * Coerce the durable delivery ledger into a JSON-safe shape.
 *
 * Only fields the sender owns are copied.  In particular, this avoids carrying
 * provider response bodies or recipient data into an alert document.
 *
 * @param {unknown} raw
 * @returns {Record<string, {state: string, at: number, attempts?: number, reason?: string, claimId?: string, provider?: string, messageId?: string}>}
 */
export function normalizeDeliveryLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const state = String(value.state || '').trim().toLowerCase();
    if (!DELIVERY_STATE_SET.has(state)) continue;
    const entry = { state, at: coerceMillis(value.at) };
    const attempts = Number(value.attempts);
    if (Number.isInteger(attempts) && attempts > 0) entry.attempts = attempts;
    for (const field of ['reason', 'claimId', 'provider', 'messageId']) {
      const text = String(value[field] || '').trim();
      if (text) entry[field] = text;
    }
    out[String(key)] = entry;
  }
  return out;
}

/**
 * Return the durable entry for a job, if it has a stable identity.
 * @param {Record<string, object>|unknown} rawLedger
 * @param {object} job
 * @returns {{state: string, at: number, attempts?: number, reason?: string, claimId?: string, provider?: string, messageId?: string}|null}
 */
export function deliveryLedgerEntryForJob(rawLedger, job) {
  const key = jobDedupKey(job);
  if (!key) return null;
  return normalizeDeliveryLedger(rawLedger)[key] || null;
}

/**
 * A job without a stable identity cannot be made idempotent.  It is therefore
 * quarantined with an explicit reason rather than silently entering the send
 * path on every run.
 *
 * @param {object} job
 * @returns {string|null}
 */
export function jobIdentityQuarantineReason(job) {
  return jobDedupKey(job) ? null : 'missing-stable-job-identity';
}

/**
 * Whether a persisted delivery outcome must block a blind retry.
 *
 * `accepted`, if encountered in a legacy/hand-edited document, is treated as
 * blocking too.  The current sender removes that transient state after it
 * updates `sentJobIds`; the conservative fallback prevents duplicates when it
 * reads an older ledger shape.
 *
 * @param {object|null|undefined} entry
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function deliveryEntryBlocksRetry(entry, nowMs = Date.now()) {
  const state = String(entry?.state || '').trim().toLowerCase();
  if (state === DELIVERY_STATES.CLAIMED) {
    const at = coerceMillis(entry?.at);
    // Missing timestamps are not safe to reclaim: an unbounded block is safer
    // than guessing that an old hand-edited entry never reached the provider.
    return !at || !Number.isFinite(nowMs) || nowMs - at < CLAIM_TTL_MS;
  }
  return state === DELIVERY_STATES.AMBIGUOUS
    || state === DELIVERY_STATES.DEFERRED_EXHAUSTED
    || state === 'accepted';
}

/**
 * Add/update delivery outcomes for the jobs in a ledger.
 *
 * @param {unknown} rawLedger
 * @param {object[]} jobs
 * @param {number} nowMs
 * @param {string} state
 * @param {Record<string, unknown>} [details]
 * @returns {Record<string, object>}
 */
export function mergeDeliveryLedger(rawLedger, jobs, nowMs, state, details = {}) {
  const normalizedState = String(state || '').trim().toLowerCase();
  if (!DELIVERY_STATE_SET.has(normalizedState)) {
    throw new Error(`Unsupported delivery ledger state: ${state}`);
  }
  const next = normalizeDeliveryLedger(rawLedger);
  for (const job of jobs || []) {
    const key = jobDedupKey(job);
    if (!key) continue;
    const entry = { state: normalizedState, at: nowMs };
    const attempts = Number(details?.attempts);
    if (Number.isInteger(attempts) && attempts > 0) entry.attempts = attempts;
    for (const field of ['reason', 'claimId', 'provider', 'messageId']) {
      const text = String(details?.[field] || '').trim();
      if (text) entry[field] = text;
    }
    next[key] = entry;
  }
  return next;
}

/**
 * Remove delivery entries for jobs whose outcome is now terminal elsewhere
 * (successful `sentJobIds` writeback or a definite provider failure).
 * @param {unknown} rawLedger
 * @param {object[]} jobs
 * @returns {Record<string, object>}
 */
export function removeDeliveryLedgerJobs(rawLedger, jobs) {
  const next = normalizeDeliveryLedger(rawLedger);
  for (const job of jobs || []) {
    const key = jobDedupKey(job);
    if (key) delete next[key];
  }
  return next;
}

/**
 * Drop jobs already sent to this alert inside the dedup window.
 *
 * @param {object[]} jobs        Candidate jobs (already scored + sorted).
 * @param {Record<string, number>} sentMap Normalized `{ key: sentAtMs }`.
 * @param {number} nowMs
 * @param {number} [windowMs=DEDUP_WINDOW_MS]
 * @param {Record<string, object>} [deliveryLedger] Durable sender outcomes.
 * @param {boolean} [quarantineIdless=true] Exclude jobs without a stable key.
 * @returns {object[]} jobs not yet sent (or sent before the window).
 */
export function filterUnsentJobs(
  jobs,
  sentMap,
  nowMs,
  windowMs = DEDUP_WINDOW_MS,
  deliveryLedger = {},
  quarantineIdless = true,
) {
  const map = sentMap || {};
  const ledger = normalizeDeliveryLedger(deliveryLedger);
  return (jobs || []).filter((job) => {
    const key = jobDedupKey(job);
    if (!key) return !quarantineIdless; // sender passes true to make quarantine explicit
    if (deliveryEntryBlocksRetry(ledger[key], nowMs)) return false;
    const sentAt = map[key];
    if (!Number.isFinite(sentAt)) return true; // never sent
    return nowMs - sentAt >= windowMs; // sent, but outside the window
  });
}

/**
 * Merge newly-sent job keys into the stored map, prune entries older than the
 * window, and cap to the most-recent `cap` entries.
 *
 * @param {Record<string, number>} sentMap Normalized existing map.
 * @param {object[]} sentJobs   Jobs that were just emailed.
 * @param {number} nowMs
 * @param {number} [windowMs=DEDUP_WINDOW_MS]
 * @param {number} [cap=SENT_JOBS_CAP]
 * @returns {Record<string, number>} the next map to persist.
 */
export function mergeSentJobs(sentMap, sentJobs, nowMs, windowMs = DEDUP_WINDOW_MS, cap = SENT_JOBS_CAP) {
  const merged = { ...(sentMap || {}) };
  for (const job of sentJobs || []) {
    const key = jobDedupKey(job);
    if (key) merged[key] = nowMs;
  }
  // Prune stale entries.
  const cutoff = nowMs - windowMs;
  let entries = Object.entries(merged).filter(([, ms]) => Number.isFinite(ms) && ms >= cutoff);
  // Cap: keep the most-recent `cap` entries.
  if (entries.length > cap) {
    entries = entries.sort((a, b) => b[1] - a[1]).slice(0, cap);
  }
  return Object.fromEntries(entries);
}
