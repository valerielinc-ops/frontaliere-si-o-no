import { buildStableJobIdentity } from './job-identity.mjs';

/**
 * Crawler oscillation ("flap") accounting.
 *
 * A flap is a job the crawler retired into its expired archive and then found
 * again a few runs later: the source never closed the vacancy, one run simply
 * failed to see it. Measured on fachkraft (group 23, 28-09 → 04-10): runs that
 * retired 277-538 jobs at once, which came back one or two runs later
 * (+672/+696, +704/+367). Every such round trip archives a live page, mints an
 * expired soft-landing, and brings the job back as "new" with whatever stale
 * locale text it had — a defect the summary did not name anywhere.
 *
 * The count is taken at the merge boundary of the run that sees the job again:
 * a job that is new in this run's diff and whose stable identity sits in the
 * crawler's own expired slice with an `expiredAt` inside the window.
 */

// Long enough to cover the miss-grace horizon of a twice-daily crawler several
// times over; short enough that an employer re-posting a closed vacancy weeks
// later is not counted as a crawler flap.
export const FLAP_WINDOW_DAYS = 7;
// Advisory floor: a handful of genuine re-posts is normal source churn. The
// measured fachkraft flaps were 8-21% of the slice (277-704 of ~3300 jobs).
export const FLAP_ADVISORY_MIN_JOBS = 20;
export const FLAP_ADVISORY_RATIO = 0.05;

const DAY_MS = 24 * 60 * 60 * 1000;

const nonNegativeInteger = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/**
 * Count the jobs that are new in this run but were retired recently.
 *
 * @param {object[]} newJobs jobs new in this run's crawl diff
 * @param {object[]} expiredEntries the crawler's expired slice before this run archives
 * @param {{ nowMs?: number, windowDays?: number }} [opts]
 * @returns {{ resurrected: number, windowDays: number, sample: string[] }}
 */
export function countResurrectedJobs(newJobs, expiredEntries, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : FLAP_WINDOW_DAYS;
  const cutoff = nowMs - windowDays * DAY_MS;
  const expiredAtByIdentity = new Map();
  for (const entry of Array.isArray(expiredEntries) ? expiredEntries : []) {
    const identity = typeof entry?.sourceIdentity === 'string' ? entry.sourceIdentity : '';
    const at = Date.parse(entry?.expiredAt || '');
    if (!identity || !Number.isFinite(at)) continue;
    const previous = expiredAtByIdentity.get(identity);
    if (previous === undefined || at > previous) expiredAtByIdentity.set(identity, at);
  }
  const sample = [];
  let resurrected = 0;
  for (const job of Array.isArray(newJobs) ? newJobs : []) {
    const at = expiredAtByIdentity.get(buildStableJobIdentity(job));
    if (at === undefined || at < cutoff || at > nowMs) continue;
    resurrected += 1;
    if (sample.length < 10 && job?.url) sample.push(job.url);
  }
  return { resurrected, windowDays, sample };
}

/** Summary-slice fields for a measured run. */
export function flapSummaryFields(raw) {
  const resurrected = nonNegativeInteger(raw?.resurrected);
  const windowDays = nonNegativeInteger(raw?.windowDays);
  if (resurrected === null || windowDays === null) return {};
  return { resurrectedJobs: resurrected, resurrectedWindowDays: windowDays };
}

/** Read the flap measurement back from a summary slice, or null when absent. */
export function flapFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const resurrected = nonNegativeInteger(summary.resurrectedJobs);
  const windowDays = nonNegativeInteger(summary.resurrectedWindowDays);
  if (resurrected === null || windowDays === null) return null;
  const written = nonNegativeInteger(summary.written);
  return { resurrected, windowDays, written };
}

/** Advisory text for crawler-health, or null when absent/under threshold. */
export function flapAdvisoryReason(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const resurrected = nonNegativeInteger(raw.resurrected);
  const written = nonNegativeInteger(raw.written);
  if (resurrected === null || resurrected < FLAP_ADVISORY_MIN_JOBS) return null;
  const ratio = written ? resurrected / written : 1;
  if (ratio < FLAP_ADVISORY_RATIO) return null;
  return `${resurrected} job(s) came back within ${raw.windowDays} day(s) of being expired `
    + `(${Math.round(ratio * 100)}% of ${written ?? 'unknown'} written, >= ${Math.round(FLAP_ADVISORY_RATIO * 100)}%): `
    + 'a partial source snapshot retired live vacancies — check which run accepted it';
}
