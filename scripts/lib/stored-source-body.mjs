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

function storedJobsByKey(storedJobs, keyOfJob) {
  const storedByKey = new Map();
  for (const job of Array.isArray(storedJobs) ? storedJobs : []) {
    const key = keyOfJob(job);
    if (key) storedByKey.set(key, job);
  }
  return storedByKey;
}

function hasValidStoredSourceBody(job) {
  const sourceLang = String(job?.sourceLang || '').trim();
  return Boolean(sourceLang && meetsSourceBodyFloor(sourceBodyForJob(job)));
}

/**
 * Return thin discovered jobs that the keeper will omit because their stored
 * source body is missing or below the shared floor. Callers use this before
 * filtering so the verified slice writer can receive quarantine evidence.
 *
 * @param {object[]} discoveredJobs
 * @param {object[]} storedJobs
 * @param {(job: object) => string} keyOfJob
 * @returns {object[]}
 */
export function findThinSourceJobsWithoutStoredBody(
  discoveredJobs = [],
  storedJobs = [],
  keyOfJob = (job) => job?.url,
) {
  const storedByKey = storedJobsByKey(storedJobs, keyOfJob);
  return (Array.isArray(discoveredJobs) ? discoveredJobs : []).filter((job) => {
    if (meetsSourceBodyFloor(sourceBodyForJob(job))) return false;
    return !hasValidStoredSourceBody(storedByKey.get(keyOfJob(job)));
  });
}

/**
 * Build the definitive proof accepted by the verified slice writer for a
 * thin-source removal. Use the writer's own removed-job objects so the URL
 * identity is exact even when a stable ID survived a source URL rewrite.
 *
 * @param {object[]} removedJobs
 * @param {object[]} thinSourceJobs
 * @param {(job: object) => string} keyOfJob
 * @returns {object[]|undefined}
 */
export function buildThinSourceHousekeepingProof(
  removedJobs = [],
  thinSourceJobs = [],
  keyOfJob = (job) => job?.url,
) {
  const removed = Array.isArray(removedJobs) ? removedJobs : [];
  const thinKeys = new Set(
    (Array.isArray(thinSourceJobs) ? thinSourceJobs : [])
      .map(keyOfJob)
      .filter(Boolean),
  );
  const quarantined = removed.filter((job) => thinKeys.has(keyOfJob(job)));
  if (quarantined.length === 0 || quarantined.length !== removed.length) return undefined;
  return quarantined.map((job) => ({
    job,
    reason: 'thin-source-quarantine',
    definitive: true,
  }));
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
  const storedByKey = storedJobsByKey(storedJobs, keyOfJob);

  return (Array.isArray(discoveredJobs) ? discoveredJobs : []).flatMap((job) => {
    if (meetsSourceBodyFloor(sourceBodyForJob(job))) return [job];
    const previous = storedByKey.get(keyOfJob(job));
    if (!hasValidStoredSourceBody(previous)) return [];
    const previousLang = String(previous.sourceLang || '').trim();
    const previousBody = sourceBodyForJob(previous);
    const kept = {
      ...job,
      description: previousBody,
      descriptionByLocale: { [previousLang]: previousBody },
      sourceLang: previousLang,
    };
    // A title or slug the runner keyed by the fallback language of the empty
    // body moves with the source language to the stored body's slot.
    for (const field of ['titleByLocale', 'slugByLocale']) {
      const map = job?.[field];
      const keys = map && typeof map === 'object' ? Object.keys(map) : [];
      if (keys.length === 1 && keys[0] === job.sourceLang && keys[0] !== previousLang) {
        kept[field] = { [previousLang]: map[keys[0]] };
      }
    }
    return [kept];
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
