import { createHash } from 'node:crypto';

const ALIGNMENT_WINDOW_MS = 6 * 60 * 60 * 1000;

function identityValue(row) {
  const value = row?.url || row?.sourceUrl || row?.id || row?.externalId || '';
  if (!value) return '';
  try {
    const url = new URL(String(value));
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function idsFor(rows) {
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map(identityValue).filter(Boolean).map(shortHash))].sort();
}

function fingerprint(ids) {
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24);
}

/**
 * Carry the runtime's completeness evidence into the snapshot. Listing
 * enumeration and promotion completeness are separate facts: comparison is
 * safe only when both are known to be complete.
 */
export function validationSnapshotMetadataFor(observation, runtimeFailed = false) {
  const exactListingCount = observation?.exactListingCount === true;
  const listingPopulationComplete = observation?.listingPopulationComplete === true;
  const observationComplete = (observation?.promotionObservationComplete
    ?? observation?.complete) === true && !runtimeFailed;
  const complete = exactListingCount && listingPopulationComplete && observationComplete;
  return {
    exactListingCount,
    listingPopulationComplete,
    runtimeSnapshotComplete: complete,
    complete,
  };
}

/**
 * A grading exception invalidates the run snapshot even if the page
 * observation itself was complete. Return a consistent failed observation,
 * completeness metadata and snapshot for the caller's retry schedule.
 */
export function validationSnapshotAfterGradeFailure(rows, observedAt, runId, observation, error) {
  const runtimeObservation = {
    ...(observation && typeof observation === 'object' ? observation : {}),
    complete: false,
    promotionObservationComplete: false,
    failure: String(error?.message || error || 'grade extraction failed').slice(0, 500),
  };
  const metadata = validationSnapshotMetadataFor(runtimeObservation, true);
  return {
    runtimeObservation,
    metadata,
    snapshot: createValidationSnapshot(rows, observedAt, runId, metadata),
  };
}

/** Persist hashed identities and the workflow run that observed them. */
export function createValidationSnapshot(
  rows,
  observedAt = new Date().toISOString(),
  runId = null,
  metadata = {},
) {
  const ids = idsFor(rows);
  return {
    observedAt,
    runId: runId ? String(runId) : null,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    uniqueIdentityCount: ids.length,
    ids,
    fingerprint: fingerprint(ids),
    complete: metadata.complete ?? true,
    exactListingCount: metadata.exactListingCount ?? true,
    listingPopulationComplete: metadata.listingPopulationComplete ?? true,
    runtimeSnapshotComplete: metadata.runtimeSnapshotComplete ?? metadata.complete ?? true,
  };
}

function validationSnapshotProblem(snapshot) {
  if (snapshot?.complete !== true
    || snapshot?.exactListingCount !== true
    || snapshot?.listingPopulationComplete !== true
    || snapshot?.runtimeSnapshotComplete !== true) {
    return 'validation_snapshot_incomplete';
  }
  if (!Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 0
    || !Number.isSafeInteger(snapshot.uniqueIdentityCount) || snapshot.uniqueIdentityCount < 0
    || !Array.isArray(snapshot.ids)) {
    return 'validation_snapshot_ids_unavailable';
  }
  if (snapshot.rowCount !== snapshot.ids.length
    || snapshot.uniqueIdentityCount !== snapshot.ids.length
    || new Set(snapshot.ids).size !== snapshot.ids.length
    || snapshot.ids.some((id) => typeof id !== 'string' || !id)
    || snapshot.fingerprint !== fingerprint(snapshot.ids)) {
    return 'validation_snapshot_ids_inconsistent';
  }
  return null;
}

function publishedSnapshotProblem(publishedSlice) {
  if (!Array.isArray(publishedSlice?.jobs)) return 'published_snapshot_ids_unavailable';
  const ids = (publishedSlice.jobs || []).map(identityValue);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return 'published_snapshot_ids_inconsistent';
  }
  return null;
}

/** Compare exact run matches, and label close cross-run counts as estimates. */
export function comparePublicationSnapshots(validationSnapshot, publishedSlice) {
  const base = {
    classification: 'unmeasured',
    validationAt: validationSnapshot?.observedAt || null,
    publishedAt: publishedSlice?.assembledAt || null,
    validationRunId: validationSnapshot?.runId || null,
    publishedRunId: publishedSlice?.runId || null,
    validationCount: Number(validationSnapshot?.rowCount) || 0,
    publishedCount: Array.isArray(publishedSlice?.jobs) ? publishedSlice.jobs.length : 0,
    shared: null,
    validationOnly: null,
    publishedOnly: null,
    deltaHours: null,
  };
  const validationProblem = validationSnapshotProblem(validationSnapshot);
  if (validationProblem) {
    return { ...base, classification: 'incomplete', reason: validationProblem };
  }
  if (!publishedSlice) return { ...base, classification: 'missing', reason: 'published_slice_missing' };
  const publishedProblem = publishedSnapshotProblem(publishedSlice);
  if (publishedProblem) {
    return { ...base, classification: 'incomplete', reason: publishedProblem };
  }
  const validationAt = Date.parse(String(validationSnapshot.observedAt || ''));
  const publishedAt = Date.parse(String(publishedSlice.assembledAt || ''));
  if (!Number.isFinite(validationAt) || !Number.isFinite(publishedAt)) {
    return { ...base, reason: 'snapshot_timestamp_unavailable' };
  }
  const deltaMs = Math.abs(validationAt - publishedAt);
  const validationIds = new Set(validationSnapshot.ids);
  const publishedIds = new Set(idsFor(publishedSlice.jobs));
  let shared = 0;
  for (const id of validationIds) if (publishedIds.has(id)) shared++;
  const counts = {
    shared,
    validationOnly: Math.max(0, validationIds.size - shared),
    publishedOnly: Math.max(0, publishedIds.size - shared),
    deltaHours: Number((deltaMs / 3_600_000).toFixed(2)),
  };
  if (deltaMs > ALIGNMENT_WINDOW_MS) {
    return { ...base, ...counts, classification: 'near_time_delta', reason: 'snapshots_more_than_6h_apart' };
  }
  const sameRun = base.validationRunId && base.publishedRunId
    && base.validationRunId === base.publishedRunId;
  if (!sameRun) {
    return {
      ...base,
      ...counts,
      classification: 'time_aligned_estimate',
      reason: base.validationRunId && base.publishedRunId ? 'run_id_mismatch' : 'run_id_missing',
    };
  }
  return {
    ...base,
    ...counts,
    classification: counts.validationOnly === 0 && counts.publishedOnly === 0 ? 'matched' : 'different_snapshot',
    reason: null,
  };
}
