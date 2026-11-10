/**
 * `crawledAt` is the liveness heartbeat of an active vacancy: the last time a
 * successful crawler run saw it at the source. Every age consumer reads it that
 * way (cleanup-jobs' STALE_DAYS age-out, the JobPosting `validThrough`
 * window, the 60-day retirement bound), so a record without it is invisible to
 * all of them: measured on main on 2026-11-10, 1.544 of 35.448 slice records
 * across 39 crawler slices had no `crawledAt` at all, because their builders
 * never set one and their runners never passed `observedJobs` to the slice
 * writer. A vacancy closed at the source could then stay active forever.
 *
 * This module owns the two halves of the contract:
 *
 * - the WRITE side (`stampWriterObservedCrawledAt`), used by
 *   `writeJobsCrawlerSlice` when its caller does not declare `observedJobs`:
 *   a successful write is the observation of every active row it carries, so
 *   those rows get a fresh heartbeat. Only rows whose heartbeat the writer
 *   owns are refreshed — rows with no valid `crawledAt` yet, or rows the
 *   writer stamped before (`crawledAtSource: 'slice-writer'`). A heartbeat a
 *   crawler sets itself at fetch time is left to that crawler, so a source
 *   that answers nothing can still age its rows out. Rows the crawler keeps
 *   only through its grace policy (`crawlerMissStreak > 0`) or already marks
 *   expired were NOT observed and are never stamped.
 * - the READ side (`jobLastObservedAtMs`), used by cleanup-jobs to age a
 *   record that still has no heartbeat by its last available observation.
 *
 * @module
 */

import { crawlerJobActivity } from './crawler-job-activity.mjs';

/** Marker of a heartbeat maintained by the slice writer, not by a crawler fetch. */
export const SLICE_WRITER_HEARTBEAT_SOURCE = 'slice-writer';

/**
 * @param {unknown} value
 * @returns {number|null} epoch ms of a parseable, positive timestamp
 */
export function timestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * @param {unknown} job
 * @returns {boolean} whether the record carries a usable `crawledAt`
 */
export function hasCrawledAtHeartbeat(job) {
  return Boolean(job && typeof job === 'object' && timestampMs(/** @type {any} */ (job).crawledAt) !== null);
}

/**
 * @param {unknown} job
 * @returns {boolean} whether the slice writer owns this record's heartbeat
 */
function isWriterOwnedHeartbeat(job) {
  return !hasCrawledAtHeartbeat(job)
    || /** @type {any} */ (job).crawledAtSource === SLICE_WRITER_HEARTBEAT_SOURCE;
}

/**
 * Stamp the heartbeat on the rows a successful slice write observed, when the
 * caller did not declare its observation explicitly (`observedJobs`).
 *
 * @param {object[]} jobs rows about to be persisted, mutated in place
 * @param {Date|string|number} [observedAt] time of the successful observation
 * @returns {number} rows whose heartbeat was refreshed
 */
export function stampWriterObservedCrawledAt(jobs, observedAt = new Date()) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const observedDate = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(observedDate.getTime())) {
    throw new TypeError('stampWriterObservedCrawledAt: observedAt must be a valid date');
  }
  const timestamp = observedDate.toISOString();
  let refreshed = 0;
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (crawlerJobActivity(job) !== 'active') continue;
    if (!isWriterOwnedHeartbeat(job)) continue;
    if (job.crawledAt !== timestamp || job.crawledAtSource !== SLICE_WRITER_HEARTBEAT_SOURCE) {
      job.crawledAt = timestamp;
      job.crawledAtSource = SLICE_WRITER_HEARTBEAT_SOURCE;
      refreshed++;
    }
  }
  return refreshed;
}

/**
 * Last time a record is known to have been seen at its source, in epoch ms.
 *
 * - A valid `crawledAt` is the answer.
 * - Without it, the latest of the remaining observations: `firstSeenAt`
 *   (discovery) and, for a row the crawler still lists as active, the time its
 *   slice was last written (`sliceObservedAtMs`). A slice write keeps a row
 *   active only when its crawler run saw it, which is exactly the observation
 *   the writer now stamps; a grace row (`crawlerMissStreak > 0`) was not seen
 *   by that write, so the slice time does not apply to it.
 * - An active row without `crawledAt` whose slice is unknown (the assembled
 *   dataset, where slice provenance is gone) returns `null`: its first-seen
 *   date alone is not its last sighting, and expiring it there would publish
 *   as expired a vacancy its slice still holds as active. The slice-mode
 *   housekeeping is where that decision is made and persisted.
 *
 * @param {unknown} job
 * @param {{ sliceObservedAtMs?: number|null }} [options]
 * @returns {number|null}
 */
export function jobLastObservedAtMs(job, { sliceObservedAtMs = null } = {}) {
  if (!job || typeof job !== 'object') return null;
  const record = /** @type {any} */ (job);
  const crawledAt = timestampMs(record.crawledAt);
  if (crawledAt !== null) return crawledAt;
  const active = crawlerJobActivity(record) === 'active';
  const sliceMs = timestampMs(sliceObservedAtMs);
  if (active && sliceMs === null) return null;
  const candidates = [timestampMs(record.firstSeenAt)];
  if (active) candidates.push(sliceMs);
  const known = candidates.filter((value) => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * Active slice records with no usable heartbeat, grouped by slice.
 *
 * @param {Array<{ file: string, jobs: unknown[] }>} slices
 * @returns {{ total: number, active: number, heartbeatless: number, byCrawler: Array<{ crawler: string, heartbeatless: number, active: number }> }}
 */
export function measureHeartbeatlessActiveJobs(slices) {
  let total = 0;
  let active = 0;
  let heartbeatless = 0;
  const byCrawler = [];
  for (const { file, jobs } of Array.isArray(slices) ? slices : []) {
    let sliceActive = 0;
    let sliceHeartbeatless = 0;
    for (const job of Array.isArray(jobs) ? jobs : []) {
      total++;
      if (crawlerJobActivity(job) !== 'active') continue;
      sliceActive++;
      if (!hasCrawledAtHeartbeat(job)) sliceHeartbeatless++;
    }
    active += sliceActive;
    heartbeatless += sliceHeartbeatless;
    if (sliceHeartbeatless > 0) {
      byCrawler.push({
        crawler: String(file).replace(/\.json$/, ''),
        heartbeatless: sliceHeartbeatless,
        active: sliceActive,
      });
    }
  }
  byCrawler.sort((a, b) => b.heartbeatless - a.heartbeatless || a.crawler.localeCompare(b.crawler));
  return { total, active, heartbeatless, byCrawler };
}
