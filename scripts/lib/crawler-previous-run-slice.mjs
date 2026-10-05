/**
 * crawler-previous-run-slice — the slice a crawler run started from, i.e. the
 * state the previous run committed, for the checks that compare this run with
 * that one.
 *
 * WHY. In the dedicated-runner path, `seedCrawlerSlicesFromDataJobs`
 * (dedicated-crawler-common.mjs) overwrites `data/jobs/by-crawler/<key>.json`
 * with this run's merged working set before the shared crawler runs. From
 * then on the file on disk is no longer the previous run's: every job of the
 * run, new arrivals included, is already in it. Measured on the first agency
 * crawls after the admission threshold (2026-10-04, fachkraft/sta/
 * stellenpartner/stellentreff): 156/16/10/7 new jobs, and the slice writer
 * judged every one of them "already in the slice" — 0 held, 104 untranslated
 * fachkraft arrivals published. The summary partition showed the same
 * comparison of the run against itself (newCount 156→0).
 *
 * THE RECORD is the slice file as this process first saw it, captured at the
 * same two points the retranslation baseline uses (crawler-retranslation-
 * baseline.mjs): the first read of every crawler runner
 * (`readExistingCrawlerJobs`) and the seed, before it writes. First record
 * per slice wins. It is keyed by the resolved slice path, so a sandbox or a
 * second checkout never reads another directory's record.
 *
 * A missing slice is recorded as empty: the previous run had published
 * nothing for that key. An unreadable slice is NOT recorded, and a recorded
 * file that does not parse as a slice (invalid JSON, or JSON without a `jobs`
 * array) reads as no record: readers fall back to the file on disk as before.
 * Treating either as empty would hold back jobs that are already online.
 *
 * The raw bytes are kept, not parsed records: later pipeline steps mutate the
 * objects they were read into, and every reader gets its own parse (one parse
 * of the largest slice, fachkraft at 24 MB, takes ~0.2 s). A Buffer, not a
 * string: it stays outside the V8 heap and at its file size (24 MB), where
 * the same text as a string takes 48 MB of heap.
 *
 * Dependency-free (node:fs/node:path only) so dedicated-crawler-common, the
 * assembler and translation-publication-hold can all import it without an
 * import cycle.
 */
import fs from 'node:fs';
import path from 'node:path';

/** @type {Map<string, Buffer|null>} resolved slice path → raw bytes (null = no slice) */
const records = new Map();

function recordKey(slicePath) {
  const value = String(slicePath || '').trim();
  return value ? path.resolve(value) : '';
}

/**
 * Record the slice at `slicePath` as the previous run's, unless this process
 * already recorded it.
 *
 * @param {string} slicePath
 * @returns {boolean} true when this call recorded it
 */
export function recordPreviousRunSlice(slicePath) {
  const key = recordKey(slicePath);
  if (!key || records.has(key)) return false;
  let raw = null;
  try {
    if (fs.existsSync(key)) raw = fs.readFileSync(key);
  } catch {
    return false;
  }
  records.set(key, raw);
  return true;
}

/**
 * Jobs of the previous run's slice at `slicePath`, freshly parsed, or null
 * when this process recorded nothing usable for it (the caller then reads the
 * file).
 *
 * @param {string} slicePath
 * @returns {object[]|null}
 */
export function previousRunSliceJobs(slicePath) {
  const key = recordKey(slicePath);
  if (!key || !records.has(key)) return null;
  const raw = records.get(key);
  if (raw == null) return [];
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.jobs)) return data.jobs;
  // Valid JSON in another shape (`{"jobs":"bad"}`, `{}`, `null`) is not a
  // slice: the same fallback as an unparsable one, never an empty prior.
  return null;
}

/** Test seam: the registry is process-wide by design. */
export function _resetPreviousRunSlices() {
  records.clear();
}
