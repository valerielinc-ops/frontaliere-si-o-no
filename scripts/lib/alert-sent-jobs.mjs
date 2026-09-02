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

// Hard cap on retained entries per alert (most-recent kept). 500 × ~40 bytes ≈
// 20 KB, comfortably under the Firestore doc limit even with the rest of the
// alert config.
export const SENT_JOBS_CAP = 500;

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
 * Drop jobs already sent to this alert inside the dedup window.
 *
 * @param {object[]} jobs        Candidate jobs (already scored + sorted).
 * @param {Record<string, number>} sentMap Normalized `{ key: sentAtMs }`.
 * @param {number} nowMs
 * @param {number} [windowMs=DEDUP_WINDOW_MS]
 * @returns {object[]} jobs not yet sent (or sent before the window).
 */
export function filterUnsentJobs(jobs, sentMap, nowMs, windowMs = DEDUP_WINDOW_MS) {
  const map = sentMap || {};
  return (jobs || []).filter((job) => {
    const key = jobDedupKey(job);
    if (!key) return true; // can't dedup an id-less job — let it through
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
