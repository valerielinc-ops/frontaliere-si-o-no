import fs from 'node:fs';
import {
  assertAccumulatorByteFloor,
  isCatastrophicAccumulatorShrink,
} from './accumulator-byte-floor-guard.mjs';
import { CRAWLER_GRACE_PERIOD_MAX_MISSES } from './crawler-grace-policy.mjs';
import { ISO_ALPHA2_COUNTRY_CODES } from './prospector/country-inventory.mjs';

const JOB_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/(?:by-crawler|expired\/by-crawler)\/[^/]+\.json$/;
const ACTIVE_JOB_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/by-crawler\/[^/]+\.json$/;
const SWISS_RE_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/by-crawler\/swiss-re\.json$/;
const TERMINAL_COUNTRY_RE = /,\s*([A-Za-z]{2})\s*$/;
// These are the only unqualified locations observed in the Swiss Re slice
// written before #9858.  The old parser stamped its Swiss Re HQ metadata on
// them even though the source did not prove a Swiss workplace.  Keep this
// allowlist deliberately narrow: a generic unknown locality must still fail
// closed at the accumulator guard.
const SWISS_RE_LEGACY_HQ_FALLBACK_LOCATION_RE = /^(?:z(?:u|ü)rich|washington d)$/i;

function normalizedPath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

function parseJobs(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.jobs) ? parsed.jobs : null;
  } catch {
    return null;
  }
}

function jobIdentity(job) {
  const url = String(job?.url ?? '').trim();
  if (url) return `url:${url}`;
  const id = String(job?.id ?? '').trim();
  return id ? `id:${id}` : null;
}

function uniqueIdentities(jobs) {
  const identities = new Set();
  for (const job of jobs) {
    const identity = jobIdentity(job);
    if (!identity || identities.has(identity)) return null;
    identities.add(identity);
  }
  return identities;
}

function normalizedJobField(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The same semantic key used by cleanup-jobs for cross-crawler dedup. */
function titleCompanyLocationKey(job) {
  const fields = [job?.title, job?.company, job?.location].map(normalizedJobField);
  return fields.every(Boolean) ? fields.join('|') : null;
}

function terminalCountryCodes(location) {
  const entries = String(location ?? '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const codes = entries.map((entry) => entry.match(TERMINAL_COUNTRY_RE)?.[1]?.toUpperCase() ?? null);
  return codes.every((code) => code && ISO_ALPHA2_COUNTRY_CODES.has(code)) ? codes : null;
}

function isExplicitSwissLocation(location) {
  const codes = terminalCountryCodes(location);
  return Boolean(codes?.length && codes.every((code) => code === 'CH'));
}

function isExplicitForeignLocation(location) {
  const codes = terminalCountryCodes(location);
  return Boolean(codes?.length && codes.every((code) => code !== 'CH'));
}

function isGraceExhaustedLegacyLocation(job) {
  const location = String(job?.location ?? '').trim();
  const missStreak = Number(job?.crawlerMissStreak);
  return Boolean(
    location
    && terminalCountryCodes(location) === null
    && Number.isInteger(missStreak)
    && missStreak >= CRAWLER_GRACE_PERIOD_MAX_MISSES
  );
}

function isGraceRetainedLegacyLocation(job) {
  const location = String(job?.location ?? '').trim();
  const missStreak = Number(job?.crawlerMissStreak);
  return Boolean(
    location
    && terminalCountryCodes(location) === null
    && Number.isInteger(missStreak)
    && missStreak > 0
    && missStreak <= CRAWLER_GRACE_PERIOD_MAX_MISSES
  );
}

function isLegacySwissReHqFallback(job) {
  return (
    String(job?.companyKey ?? '').trim() === 'swiss-re'
    && normalizedJobField(job?.source) === 'swiss re dedicated parser'
    && normalizedJobField(job?.addressCountry) === 'ch'
    && normalizedJobField(job?.country) === 'ch'
    && normalizedJobField(job?.canton) === 'zh'
    && normalizedJobField(job?.addressRegion) === 'zh'
    && SWISS_RE_LEGACY_HQ_FALLBACK_LOCATION_RE.test(normalizedJobField(job?.location))
  );
}

export function isCrawlerSlicePath(filePath) {
  return JOB_SLICE_PATH_RE.test(normalizedPath(filePath));
}

/**
 * Recognise only the Swiss Re source-geography migration proved by issue
 * #9876: every retained record is explicitly Swiss or an ambiguous legacy
 * record still carrying a positive miss streak within the merge grace period,
 * and every removed record is either explicitly non-CH, an ambiguous legacy
 * record whose grace is exhausted, or the exact legacy HQ-fallback marker
 * observed before #9858. Unknown, mixed, malformed, or empty locations stay
 * on the generic fail-closed path.
 */
export function isSafeSwissReForeignPruneJobs(filePath, previousJobs, nextJobs) {
  if (!SWISS_RE_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length || nextJobs.length === 0) {
    return false;
  }

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds) return false;

  for (const job of nextJobs) {
    if (!isExplicitSwissLocation(job?.location) && !isGraceRetainedLegacyLocation(job)) return false;
    if (String(job?.companyKey ?? '').trim() !== 'swiss-re') return false;
  }

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removedJobs.length === 0) {
    return false;
  }
  return removedJobs.every((job) => (
    String(job?.companyKey ?? '').trim() === 'swiss-re'
    && (
      isExplicitForeignLocation(job?.location)
      || isGraceExhaustedLegacyLocation(job)
      || isLegacySwissReHqFallback(job)
    )
  ));
}

export function isSafeSwissReForeignPrune(filePath, previousRaw, nextRaw) {
  return isSafeSwissReForeignPruneJobs(filePath, parseJobs(previousRaw), parseJobs(nextRaw));
}

/**
 * Prove the only intentional large shrink performed by prune-dedup-from-slices.
 *
 * That command receives the post-dedup assembled dataset, so the surviving
 * duplicate can live in another crawler slice and will not be present in the
 * file being written. The proof therefore requires every removed record to:
 *   - be an unambiguous subset removal (no replacement or identity collision),
 *   - be absent from the assembled reference by URL/id, and
 *   - have its exact title+company+location key represented by a different
 *     record in that reference.
 *
 * Without this explicit reference the generic accumulator guard stays closed.
 */
export function isProvenCrossCrawlerDedupPrune(filePath, previousRaw, nextRaw, referenceJobs) {
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  const previousJobs = parseJobs(previousRaw);
  const nextJobs = parseJobs(nextRaw);
  const reference = Array.isArray(referenceJobs) ? referenceJobs : parseJobs(referenceJobs);
  if (!previousJobs || !nextJobs || !reference || previousJobs.length <= nextJobs.length) {
    return false;
  }

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || [...nextIds].some((identity) => !previousIds.has(identity))) return false;

  const removed = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removed.length !== previousJobs.length - nextJobs.length || removed.some((job) => !jobIdentity(job))) {
    return false;
  }

  const referenceIds = new Set(reference.map(jobIdentity).filter(Boolean));
  if (removed.some((job) => referenceIds.has(jobIdentity(job)))) return false;
  const referenceKeys = new Set(reference.map(titleCompanyLocationKey).filter(Boolean));
  return removed.every((job) => {
    const key = titleCompanyLocationKey(job);
    return key !== null && referenceKeys.has(key);
  });
}

/**
 * Prove a large housekeeping shrink from definitive URL evidence.
 *
 * Housekeeping is allowed to remove a job only after the validator has
 * returned a definitive dead verdict (404/410, a closed-portal marker, or a
 * generic-listing redirect).  The proof is carried alongside the write so the
 * byte guard can distinguish that intentional expiry from a reader that
 * silently fell back to an empty accumulator.
 *
 * Non-definitive failures are deliberately not accepted here, even though
 * ordinary housekeeping may remove an old unprotected row for those signals:
 * a catastrophic shrink needs stronger evidence than a normal prune.
 */
export function isProvenHousekeepingPrune(filePath, previousRaw, nextRaw, proofEntries) {
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  const previousJobs = parseJobs(previousRaw);
  const nextJobs = parseJobs(nextRaw);
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length) return false;
  if (!Array.isArray(proofEntries) || proofEntries.length === 0) return false;

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || [...nextIds].some((identity) => !previousIds.has(identity))) {
    return false;
  }

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removedJobs.length !== previousJobs.length - nextJobs.length || removedJobs.some((job) => !jobIdentity(job))) {
    return false;
  }

  const provenIds = new Set();
  for (const entry of proofEntries) {
    if (entry?.definitive !== true) return false;
    const identity = jobIdentity(entry.job);
    if (!identity || provenIds.has(identity)) return false;
    provenIds.add(identity);
  }

  if (provenIds.size !== removedJobs.length) return false;
  return removedJobs.every((job) => provenIds.has(jobIdentity(job)));
}

/**
 * Guard the final bytes written for a crawler slice. The semantic exception
 * is deliberately narrower than the byte guard and is shared by all writers
 * so a later merge/ownership step cannot reintroduce the false positive.
 */
export function assertCrawlerSliceWriteSafe(
  filePath,
  previousRaw,
  nextRaw,
  { dedupReferenceJobs = null, housekeepingProof = null } = {},
) {
  const previousBytes = Buffer.byteLength(String(previousRaw), 'utf8');
  const nextBytes = Buffer.byteLength(String(nextRaw), 'utf8');
  if (!isCatastrophicAccumulatorShrink(previousBytes, nextBytes)) {
    return { previousBytes, nextBytes, reason: null };
  }
  if (isSafeSwissReForeignPrune(filePath, previousRaw, nextRaw)) {
    return { previousBytes, nextBytes, reason: 'swiss-re-foreign-prune' };
  }
  if (isProvenCrossCrawlerDedupPrune(filePath, previousRaw, nextRaw, dedupReferenceJobs)) {
    return { previousBytes, nextBytes, reason: 'proven-cross-crawler-dedup' };
  }
  if (isProvenHousekeepingPrune(filePath, previousRaw, nextRaw, housekeepingProof)) {
    return { previousBytes, nextBytes, reason: 'proven-housekeeping-prune' };
  }
  assertAccumulatorByteFloor(previousBytes, nextBytes, { label: filePath });
  return { previousBytes, nextBytes, reason: null };
}

function runCli() {
  const [filePath, previousPath, nextPath, housekeepingProofPath] = process.argv.slice(2);
  if (!filePath || !previousPath || !nextPath) {
    console.error('usage: crawler-slice-integrity.mjs <file> <previous> <next> [housekeeping-proof]');
    process.exitCode = 2;
    return;
  }
  try {
    let housekeepingProof = null;
    if (housekeepingProofPath) {
      const proof = JSON.parse(fs.readFileSync(housekeepingProofPath, 'utf8'));
      if (
        !proof
        || proof.schemaVersion !== 1
        || normalizedPath(proof.path) !== normalizedPath(filePath)
        || !Array.isArray(proof.entries)
      ) {
        throw new Error(`invalid or path-mismatched housekeeping proof for ${filePath}`);
      }
      housekeepingProof = proof.entries;
    }
    const result = assertCrawlerSliceWriteSafe(
      filePath,
      fs.readFileSync(previousPath, 'utf8'),
      fs.readFileSync(nextPath, 'utf8'),
      { housekeepingProof },
    );
    if (result.reason) console.log(`crawler slice integrity: allowed ${result.reason} for ${filePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('crawler-slice-integrity.mjs')) runCli();
