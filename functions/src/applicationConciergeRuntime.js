import { FieldValue } from 'firebase-admin/firestore';

export const APPLICATION_CONCIERGE_RUNTIME_SCHEMA_VERSION = 2;
export const APPLICATION_CONCIERGE_RUNTIME_COLLECTION = 'runtime';
export const APPLICATION_CONCIERGE_MATCHING_RUNTIME_DOCUMENT = 'matching';

export const APPLICATION_CONCIERGE_MATCHING_RUNTIME_FIELDS = Object.freeze([
  'matchingEventRefreshRequestedAt',
  'matchingOpenProposalCount',
  'matchingScanCursor',
  'matchingScanContext',
  'matchingStartedAt',
  'matchingEligibilityRecoveryCount',
  'matchingEligibilityRecoveryDurationMsTotal',
  'matchingEligibilityLastRecoveryMs',
  'matchingEligibilityLastRecoveryStatus',
  'matchingEligibilityLastRecoveryAt',
  'matchingStaleRecoveryContext',
  'matchingStaleRecoveryAttempt',
  'matchingStaleRecoveryRetryAt',
  'matchingStaleRecoveryStartedAt',
  'matchingStaleRecoveryExhaustedAt',
  'proposalRefreshClaimedAt',
  'proposalRefreshClaimId',
  'proposalRefreshRerunAfterWorker',
  'proposalRefreshRerunAfterWorkerContext',
  'proposalRefreshRerunRequestedAt',
  'proposalRefreshWorkerLeaseId',
  'proposalRefreshWorkerLeaseExpiresAt',
  'proposalRefreshWorkerStartedAt',
  'proposalRefreshWorkerRequestId',
  'proposalRefreshWorkerInputContext',
]);

const LEGACY_FIELDS_TO_REMOVE = APPLICATION_CONCIERGE_MATCHING_RUNTIME_FIELDS
  .filter(field => field !== 'matchingOpenProposalCount');

export function conciergeMatchingRuntimeRef(serviceRef) {
  return serviceRef.collection(APPLICATION_CONCIERGE_RUNTIME_COLLECTION)
    .doc(APPLICATION_CONCIERGE_MATCHING_RUNTIME_DOCUMENT);
}

/** Runtime values win once a runtime document is versioned; otherwise old fields remain readable. */
export function mergeConciergeMatchingRuntime(service = {}, runtime = null) {
  const merged = { ...service };
  if (!runtime || typeof runtime !== 'object') return merged;
  const migrated = Number(runtime.schemaVersion) >= APPLICATION_CONCIERGE_RUNTIME_SCHEMA_VERSION;
  for (const field of APPLICATION_CONCIERGE_MATCHING_RUNTIME_FIELDS) {
    if (Object.hasOwn(runtime, field)) merged[field] = runtime[field];
    else if (migrated) delete merged[field];
  }
  return merged;
}

/**
 * Copy legacy operational fields on the first runtime write, then delete the
 * old parent copies. The proposal count is kept as a compatibility mirror for
 * existing clients and is refreshed at matching completion or user actions.
 */
export function writeConciergeMatchingRuntime(transaction, serviceRef, runtimeRef, service, runtime, patch) {
  const migrated = Number(runtime?.schemaVersion) >= APPLICATION_CONCIERGE_RUNTIME_SCHEMA_VERSION;
  const legacyValues = {};
  if (!migrated) {
    for (const field of APPLICATION_CONCIERGE_MATCHING_RUNTIME_FIELDS) {
      if (Object.hasOwn(service || {}, field) && !Object.hasOwn(runtime || {}, field)) {
        legacyValues[field] = service[field];
      }
    }
  }
  transaction.set(runtimeRef, {
    ...legacyValues,
    ...patch,
    schemaVersion: APPLICATION_CONCIERGE_RUNTIME_SCHEMA_VERSION,
  }, { merge: true });
  if (!migrated) {
    const removals = Object.fromEntries(LEGACY_FIELDS_TO_REMOVE
      .filter(field => Object.hasOwn(service || {}, field))
      .map(field => [field, FieldValue.delete()]));
    if (Object.keys(removals).length) transaction.set(serviceRef, removals, { merge: true });
  }
}

export async function updateConciergeMatchingRuntime({ db, serviceRef, patch }) {
  const runtimeRef = conciergeMatchingRuntimeRef(serviceRef);
  return db.runTransaction(async transaction => {
    const [serviceSnapshot, runtimeSnapshot] = await Promise.all([
      transaction.get(serviceRef),
      transaction.get(runtimeRef),
    ]);
    const service = serviceSnapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    writeConciergeMatchingRuntime(transaction, serviceRef, runtimeRef, service, runtime, patch);
    return mergeConciergeMatchingRuntime(service, { ...runtime, ...patch,
      schemaVersion: APPLICATION_CONCIERGE_RUNTIME_SCHEMA_VERSION });
  });
}
