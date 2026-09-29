/**
 * Keep the source body of a vacancy whose fresh read fell under the shared
 * word floor (source-body-floor.mjs).
 *
 * A crawler that no longer pads a thin or unreadable detail page with text
 * of its own (#5253) has two honest options for such a vacancy: publish the
 * body stored from an earlier read of the SAME source page, or not publish
 * the vacancy this run. Stored text the crawler once invented must already
 * be removed (drop-fabricated-description.mjs) before this runs, so what is
 * kept is always source text.
 */
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/**
 * Return only the source-locale body of a job. The flat field is the legacy
 * fallback used by older slices; a declared source-locale slot is preferred so
 * a translated locale can never make a source read look healthy.
 *
 * @param {object} job
 * @returns {string}
 */
export function sourceBodyForJob(job = {}) {
  const sourceLang = String(job?.sourceLang || '').trim();
  const localized = sourceLang && job?.descriptionByLocale?.[sourceLang];
  const localizedText = String(localized || '').trim();
  return localizedText || String(job?.description || '').trim();
}

/**
 * Shared implementation for callers whose merge identity is job-shaped.
 *
 * @param {object[]} discoveredJobs
 * @param {object[]} storedJobs
 * @param {(job: object) => string} keyOfJob
 * @returns {object[]}
 */
export function keepStoredSourceBodiesByKey(
  discoveredJobs = [],
  storedJobs = [],
  keyOfJob = (job) => job?.url,
) {
  const storedByKey = new Map();
  for (const job of Array.isArray(storedJobs) ? storedJobs : []) {
    const key = keyOfJob(job);
    if (key) storedByKey.set(key, job);
  }

  return (Array.isArray(discoveredJobs) ? discoveredJobs : []).flatMap((job) => {
    if (meetsSourceBodyFloor(sourceBodyForJob(job))) return [job];
    const previous = storedByKey.get(keyOfJob(job));
    const previousLang = String(previous?.sourceLang || '').trim();
    const previousBody = sourceBodyForJob(previous);
    if (!previousLang || !meetsSourceBodyFloor(previousBody)) return [];
    return [{
      ...job,
      description: previousBody,
      descriptionByLocale: { [previousLang]: previousBody },
      sourceLang: previousLang,
    }];
  });
}

/**
 * @param {object[]} discoveredJobs  fresh jobs; `description` is '' when the
 *   source body was under the floor
 * @param {object[]} storedJobs      stored jobs of the same crawler
 * @param {(url: string) => string} keyOf  stable id of a job URL
 * @returns {object[]} the jobs to publish: fresh ones over the floor, and the
 *   others with their stored source body; the rest is left out this run.
 */
export function keepStoredSourceBodies(discoveredJobs = [], storedJobs = [], keyOf = (url) => url) {
  return keepStoredSourceBodiesByKey(
    discoveredJobs,
    storedJobs,
    (job) => keyOf(job?.url),
  );
}
