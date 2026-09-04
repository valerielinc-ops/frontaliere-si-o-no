/**
 * Job dataset churn guard (#6702).
 *
 * `data/jobs-stats-history.json` records daily added/removed job counts, but
 * nothing ever compared a day against its own recent history: a host that
 * dumps +3.015 pages in one day and gets it reabsorbed 3 days later nets out
 * to ~zero on `totalJobs` and passes every existing check in silence
 * (2026-08-24 fachkraft.ch spike, see issue #6702).
 *
 * `detectChurnAnomalies()` flags a day's `added`/`removed` when it exceeds a
 * trailing-baseline mean by several standard deviations AND clears an
 * absolute floor (so a quiet baseline near zero doesn't trip on ordinary
 * day-to-day noise). When a metric is flagged, it also attributes the day's
 * `addedKeys`/`removedKeys` (still full arrays for "today", see
 * `job-board-stats.mjs` retention comment) by URL host, so the resulting
 * issue names the dominant contributor instead of just the raw total.
 *
 * It also flags the opposite failure mode (#6713): a stale snapshot re-run
 * with small `added`/`removed` never clears `ABSOLUTE_FLOOR`, so a crawler
 * orchestration that silently stopped writing fresh data (2026-08-29/30)
 * stays invisible to the spike checks above. This is a plain equality check
 * on the two most recent entries across `totalJobs`+`added`+`updated`+
 * `removed`, independent of `MIN_BASELINE_DAYS`.
 */

import { createHash } from 'node:crypto';

const MIN_BASELINE_DAYS = 7; // bootstrap guard: too little history to have a distribution
const STDDEV_MULTIPLIER = 4; // ~4 sigma — the 2026-08-24/27/28 spikes were 5-6 sigma out
const ABSOLUTE_FLOOR = 1500; // never flag below this even if the baseline is near-zero
const STALE_SNAPSHOT_FIELDS = ['totalJobs', 'added', 'updated', 'removed'];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values, avg) {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function extractHost(key) {
  if (typeof key !== 'string' || !key.startsWith('url:')) return null;
  try {
    return new URL(key.slice(4)).hostname;
  } catch {
    return null;
  }
}

function topHostContributors(keys, limit = 5) {
  const counts = new Map();
  for (const key of safeArray(keys)) {
    const host = extractHost(key);
    if (!host) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/**
 * A day is a "stale snapshot" when it repeats the previous day's
 * `totalJobs`+`added`+`updated`+`removed` exactly — a crawler orchestration
 * that stopped producing fresh data instead of a genuinely quiet day.
 */
function detectStaleSnapshot(entries) {
  if (entries.length < 2) return null;
  const previous = entries[entries.length - 2];
  const latest = entries[entries.length - 1];
  const isStale = STALE_SNAPSHOT_FIELDS.every(
    (field) => Number(previous[field] || 0) === Number(latest[field] || 0)
  );
  if (!isStale) return null;

  return {
    date: latest.date,
    metric: 'stale-snapshot',
    issueTitle: '[job-dataset-churn] stale snapshot',
    observed: STALE_SNAPSHOT_FIELDS.map((field) => `${field}=${latest[field]}`).join(', '),
    baselineMean: null,
    baselineStddev: null,
    threshold: null,
    baselineDays: 1,
    topHosts: [],
  };
}

/**
 * @param {object} history - parsed `data/jobs-stats-history.json`
 * @param {object} [options]
 * @param {number} [options.minBaselineDays]
 * @param {number} [options.stddevMultiplier]
 * @param {number} [options.absoluteFloor]
 * @returns {Array<object>} one entry per flagged metric on the latest day
 */
export function detectChurnAnomalies(history = {}, options = {}) {
  const minBaselineDays = options.minBaselineDays ?? MIN_BASELINE_DAYS;
  const stddevMultiplier = options.stddevMultiplier ?? STDDEV_MULTIPLIER;
  const absoluteFloor = options.absoluteFloor ?? ABSOLUTE_FLOOR;

  const entries = safeArray(history?.entries)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const anomalies = [];

  const staleSnapshot = detectStaleSnapshot(entries);
  if (staleSnapshot) anomalies.push(staleSnapshot);

  if (entries.length < minBaselineDays + 1) return anomalies; // not enough history to judge spikes

  const today = entries[entries.length - 1];
  const baseline = entries.slice(-(minBaselineDays + 1), -1);

  for (const metric of ['added', 'removed']) {
    const baselineValues = baseline.map((e) => Number(e[metric] || 0));
    const avg = mean(baselineValues);
    const sd = stddev(baselineValues, avg);
    const observed = Number(today[metric] || 0);
    const threshold = avg + stddevMultiplier * sd;

    if (observed < absoluteFloor || observed <= threshold) continue;

    const keysField = metric === 'added' ? 'addedKeys' : 'removedKeys';
    const topHosts = topHostContributors(today[keysField]);
    const dominantHost = topHosts[0]?.host;
    const dominantHostKey = dominantHost
      ? createHash('sha256').update(dominantHost).digest('hex').slice(0, 10)
      : null;
    const issueScope = dominantHostKey || `unattributed-${today.date}`;
    const issueSubject = dominantHost || 'unknown-host';
    anomalies.push({
      date: today.date,
      metric,
      // Keep the title stable across consecutive days for the same source so
      // github-issue-creator comments on the live event instead of minting one
      // issue per day. Different metric/host combinations remain distinct.
      // When attribution is unavailable, retain the date as a fail-safe: two
      // unknown events must not be silently collapsed.
      issueTitle: `[job-dataset-churn] ${metric} spike ${issueScope}: ${issueSubject}`,
      observed,
      baselineMean: round(avg),
      baselineStddev: round(sd),
      threshold: round(threshold),
      baselineDays: baseline.length,
      topHosts,
    });
  }

  return anomalies;
}
