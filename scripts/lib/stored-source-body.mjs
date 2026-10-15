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
import { hasSourceBodyFailure, SOURCE_BODY_FAILURE_REASON } from './source-body-failure.mjs';

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
 * The stored record without the markers of a failed fresh read.
 *
 * @param {object} job
 * @returns {object}
 */
function withoutSourceBodyFailure(job) {
  const kept = { ...job };
  delete kept.sourceBodyFailureReason;
  delete kept.sourceBodyFailureMessage;
  delete kept.sourceBodyFailureKeepsStoredRecord;
  return kept;
}

/**
 * Whether a stored record still carries a publishable source body.
 *
 * @param {object} job
 * @returns {boolean}
 */
function hasPublishableStoredBody(job) {
  return Boolean(String(job?.sourceLang || '').trim()) && meetsSourceBodyFloor(sourceBodyForJob(job));
}

/**
 * The stored record to republish for a vacancy whose source read failed in
 * this run, or null when no stored record with a publishable body exists.
 *
 * keepStoredSourceBodiesByKey() keeps the stored BODY under the fresh row's
 * other fields, which is right when those fields do not come from the body.
 * A source whose title, slug or locality are read from the PDF text itself
 * (LWPHR, Berit Klinik, ECAM) would rebuild a failed row from an empty body:
 * another title, another slug, no locality, so the vacancy that was online
 * would change identity or be dropped by the assembler. The whole stored
 * record keeps every derived field together with the body it came from.
 *
 * @param {string} key identity of the failed vacancy
 * @param {object[]} storedJobs
 * @param {(job: object) => string} keyOfJob
 * @returns {object|null}
 */
export function storedJobForFailedSource(key, storedJobs = [], keyOfJob = (job) => job?.url) {
  if (!key) return null;
  const previous = (Array.isArray(storedJobs) ? storedJobs : []).find((job) => keyOfJob(job) === key);
  return previous && hasPublishableStoredBody(previous) ? withoutSourceBodyFailure(previous) : null;
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
    const sourceBodyFailed = hasSourceBodyFailure(job);
    if (meetsSourceBodyFloor(sourceBodyForJob(job))) return [job];
    const previous = storedByKey.get(keyOfJob(job));
    const previousLang = String(previous?.sourceLang || '').trim();
    const previousBody = sourceBodyForJob(previous);
    if (!previousLang || !meetsSourceBodyFloor(previousBody)) return [];
    // A failed row whose identity fields derive from the source body asks for
    // the stored record whole (see storedJobForFailedSource).
    if (sourceBodyFailed && job?.sourceBodyFailureKeepsStoredRecord === true) {
      return [withoutSourceBodyFailure(previous)];
    }
    const kept = {
      ...job,
      description: previousBody,
      descriptionByLocale: { [previousLang]: previousBody },
      sourceLang: previousLang,
    };
    if (sourceBodyFailed) {
      // A parser/fetch failure is operational, not thin source. Once a valid
      // source body has been restored, do not persist the transient failure
      // marker on the published job.
      delete kept.sourceBodyFailureReason;
      delete kept.sourceBodyFailureMessage;
    }
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
 * The stored rows the merge may still re-add: every row except those whose
 * key is in `keys` and whose own body is not publishable.
 *
 * @param {object[]} existingJobs
 * @param {Set<string>} keys
 * @param {(job: object) => string} keyOfJob
 * @returns {object[]}
 */
function dropStoredJobsWithoutValidBody(existingJobs, keys, keyOfJob) {
  const existing = Array.isArray(existingJobs) ? existingJobs : [];
  if (keys.size === 0) return existing;
  return existing.filter((job) => !keys.has(keyOfJob(job)) || hasPublishableStoredBody(job));
}

/**
 * @param {object[]} discoveredJobs
 * @param {(job: object) => boolean} predicate
 * @param {(job: object) => string} keyOfJob
 * @returns {Set<string>}
 */
function keysOfDiscovered(discoveredJobs, predicate, keyOfJob) {
  return new Set(
    (Array.isArray(discoveredJobs) ? discoveredJobs : [])
      .filter(predicate)
      .map(keyOfJob)
      .filter(Boolean),
  );
}

/**
 * Remove stored rows for source extractions that failed in this run when no
 * valid source body exists to keep publishing. A failed discovery is already
 * absent from keepStoredSourceBodiesByKey(); this second filter prevents the
 * merge from re-adding the old empty/thin row through its existing-jobs input.
 *
 * @param {object[]} existingJobs stored jobs passed to the merge
 * @param {object[]} discoveredJobs fresh jobs, including failed extractions
 * @param {(job: object) => string} keyOfJob stable job identity
 * @returns {object[]}
 */
export function dropFailedSourceJobsWithoutValidBody(
  existingJobs = [],
  discoveredJobs = [],
  keyOfJob = (job) => job?.url,
) {
  return dropStoredJobsWithoutValidBody(
    existingJobs,
    keysOfDiscovered(discoveredJobs, hasSourceBodyFailure, keyOfJob),
    keyOfJob,
  );
}

/**
 * dropFailedSourceJobsWithoutValidBody() for every fresh read under the word
 * floor: a failed extraction, and also a thin one (an image-only PDF). Only
 * for a crawler without the thin-source quarantine (crawler-template.mjs runs
 * one and needs the thin row in the merge to prove its removal): there,
 * mergePreserveLocaleData() would keep the stored row under its grace period
 * and republish a body that is under the floor too.
 *
 * @param {object[]} existingJobs stored jobs passed to the merge
 * @param {object[]} discoveredJobs fresh jobs, before keepStoredSourceBodiesByKey()
 * @param {(job: object) => string} keyOfJob stable job identity
 * @returns {object[]}
 */
export function dropUnreadableSourceJobsWithoutValidBody(
  existingJobs = [],
  discoveredJobs = [],
  keyOfJob = (job) => job?.url,
) {
  return dropStoredJobsWithoutValidBody(
    existingJobs,
    keysOfDiscovered(
      discoveredJobs,
      (job) => hasSourceBodyFailure(job) || !meetsSourceBodyFloor(sourceBodyForJob(job)),
      keyOfJob,
    ),
    keyOfJob,
  );
}

/**
 * Collect the source-body records that must be quarantined after the stored
 * body fallback has had its chance.
 *
 * Prefer a thin record already present in the merged result: its URL and
 * route history are the identities the slice writer will actually remove.
 * A thin discovery that was dropped before the merge is included only when
 * no merged record has the same key.
 *
 * @param {object[]} discoveredJobs fresh records, including thin bodies
 * @param {object[]} mergedJobs records after the source-body fallback/merge
 * @param {(job: object) => string} keyOfJob stable job identity
 * @returns {object[]} thin records eligible for quarantine proof
 */
export function collectThinSourceJobsForQuarantine(
  discoveredJobs = [],
  mergedJobs = [],
  keyOfJob = (job) => job?.url,
) {
  const mergedByKey = new Map();
  for (const job of Array.isArray(mergedJobs) ? mergedJobs : []) {
    const key = keyOfJob(job);
    if (key !== undefined && key !== null && key !== '') mergedByKey.set(key, job);
  }

  const thinJobs = [...mergedByKey.values()]
    .filter((job) => !hasSourceBodyFailure(job))
    .filter((job) => !meetsSourceBodyFloor(sourceBodyForJob(job)));
  const mergedKeys = new Set(mergedByKey.keys());
  for (const job of Array.isArray(discoveredJobs) ? discoveredJobs : []) {
    const key = keyOfJob(job);
    if (
      key !== undefined
      && key !== null
      && key !== ''
      && !mergedKeys.has(key)
      && !hasSourceBodyFailure(job)
      && !meetsSourceBodyFloor(sourceBodyForJob(job))
    ) {
      thinJobs.push(job);
    }
  }
  return thinJobs;
}

/**
 * Build deterministic housekeeping evidence for a failed source extraction.
 * This is intentionally separate from thin-source quarantine: a live PDF that
 * could not be parsed is a crawler error, not evidence that the vacancy is a
 * thin source.
 */
export function buildSourceBodyFailureHousekeepingProof(
  removedJobs = [],
  failedJobs = [],
  keyOfJob = (job) => job?.url,
) {
  const failedKeys = new Set(
    (Array.isArray(failedJobs) ? failedJobs : [])
      .map(keyOfJob)
      .filter(Boolean),
  );
  const failed = (Array.isArray(removedJobs) ? removedJobs : [])
    .filter((job) => failedKeys.has(keyOfJob(job)));
  if (failed.length === 0) return undefined;
  return failed.map((job) => ({
    job,
    reason: SOURCE_BODY_FAILURE_REASON,
    definitive: true,
  }));
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
