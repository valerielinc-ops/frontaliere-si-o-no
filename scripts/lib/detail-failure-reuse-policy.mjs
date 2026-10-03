/**
 * Shared policy for a bounded detail-page outage.
 *
 * A detail failure may be tolerated only when the attempted set is explicit,
 * the failure ratio stays within the small grace window, and a caller can
 * return a previously validated row for the exact same identity. Callers may
 * choose whether every failed identity must have such a row: job snapshots
 * require that proof before their authoritative validator passes, while event
 * listings can still publish a source-backed listing row for a brand-new event
 * that has no previous snapshot yet.
 */

// One threshold for the fail-closed reuse policy and the crawler health
// advisory. Keeping the value here prevents those two views of detail drift
// from silently diverging.
export const DETAIL_FAILURE_RATIO_THRESHOLD = 0.15;
export const DETAIL_FAILURE_MAX_RATIO = DETAIL_FAILURE_RATIO_THRESHOLD;

/**
 * @param {number} detailFailureCount
 * @param {number} attemptedCount
 * @returns {boolean}
 */
export function isDetailFailureWithinGrace(detailFailureCount, attemptedCount) {
  return Number.isInteger(detailFailureCount)
    && Number.isInteger(attemptedCount)
    && attemptedCount > 0
    && detailFailureCount >= 0
    && detailFailureCount <= attemptedCount
    && detailFailureCount / attemptedCount <= DETAIL_FAILURE_MAX_RATIO;
}

function defaultNormalizeIdentity(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

/**
 * Replace failed fresh rows with exact, validated rows from the previous
 * snapshot and return the accounting that the caller must carry to its gate.
 *
 * @param {object} options
 * @param {Array<Record<string, any>>} [options.freshRows]
 * @param {Iterable<unknown>} [options.failedIdentities]
 * @param {number} [options.attemptedCount]
 * @param {Array<Record<string, any>>} [options.previousRows]
 * @param {(row: Record<string, any>) => unknown} [options.identityOf]
 * @param {(identity: unknown) => string} [options.normalizeIdentity]
 * @param {(previous: Record<string, any>, identity: string) => Record<string, any>|null} [options.fallbackOf]
 * @param {boolean} [options.requireReuse]
 * @returns {{
 *   rows: Array<Record<string, any>>,
 *   attemptedCount: number,
 *   detailFailureCount: number,
 *   detailFailureIdentities: string[],
 *   reusedDetailCount: number,
 *   reusedDetailIdentities: string[],
 *   previousSnapshotIdentityCollisionCount: number,
 *   invalidFailureIdentityCount: number,
 *   duplicateFailureIdentityCount: number,
 *   withinGrace: boolean,
 *   fullyReused: boolean,
 *   canPublish: boolean,
 * }}
 */
export function applyDetailFailureReuse({
  freshRows = [],
  failedIdentities = [],
  attemptedCount,
  previousRows = [],
  identityOf = (row) => row?.url,
  normalizeIdentity = defaultNormalizeIdentity,
  fallbackOf = (previous) => previous,
  requireReuse = false,
} = {}) {
  const normalize = (value) => {
    try {
      return String(normalizeIdentity(value) || '').trim();
    } catch {
      return '';
    }
  };
  const rawFailures = Array.from(failedIdentities || []);
  const normalizedFailures = rawFailures.map(normalize);
  const invalidFailureIdentityCount = normalizedFailures.filter((identity) => !identity).length;
  const failureIdentities = [...new Set(normalizedFailures.filter(Boolean))];
  const duplicateFailureIdentityCount = Math.max(
    0,
    rawFailures.length - invalidFailureIdentityCount - failureIdentities.length,
  );

  const previousByIdentity = new Map();
  const duplicatePreviousIdentities = new Set();
  for (const previous of Array.isArray(previousRows) ? previousRows : []) {
    let identity = '';
    try { identity = normalize(identityOf(previous)); } catch { /* malformed previous row */ }
    if (!identity) continue;
    if (previousByIdentity.has(identity)) {
      duplicatePreviousIdentities.add(identity);
      previousByIdentity.set(identity, null);
      continue;
    }
    previousByIdentity.set(identity, previous);
  }

  const fallbackByIdentity = new Map();
  for (const identity of failureIdentities) {
    if (duplicatePreviousIdentities.has(identity)) continue;
    const previous = previousByIdentity.get(identity);
    if (!previous) continue;
    let fallback = null;
    try { fallback = fallbackOf(previous, identity); } catch { fallback = null; }
    if (!fallback || typeof fallback !== 'object') continue;
    let fallbackIdentity = '';
    try { fallbackIdentity = normalize(identityOf(fallback)); } catch { /* reject */ }
    if (fallbackIdentity !== identity) continue;
    fallbackByIdentity.set(identity, fallback);
  }

  const rows = (Array.isArray(freshRows) ? freshRows : []).map((row) => {
    let identity = '';
    try { identity = normalize(identityOf(row)); } catch { /* retain the fresh row */ }
    return identity && fallbackByIdentity.has(identity) ? fallbackByIdentity.get(identity) : row;
  });
  const presentIdentities = new Set();
  for (const row of rows) {
    try {
      const identity = normalize(identityOf(row));
      if (identity) presentIdentities.add(identity);
    } catch { /* malformed fresh row is handled by its caller's gate */ }
  }
  for (const [identity, fallback] of fallbackByIdentity) {
    if (!presentIdentities.has(identity)) rows.push(fallback);
  }

  const attempted = Number.isInteger(attemptedCount) ? attemptedCount : Number(attemptedCount);
  const detailFailureCount = failureIdentities.length;
  const reusedDetailIdentities = failureIdentities.filter((identity) => fallbackByIdentity.has(identity));
  const reusedDetailCount = reusedDetailIdentities.length;
  const previousSnapshotIdentityCollisionCount = failureIdentities.filter((identity) =>
    duplicatePreviousIdentities.has(identity)).length;
  const withinGrace = detailFailureCount === 0
    || isDetailFailureWithinGrace(detailFailureCount, attempted);
  const fullyReused = detailFailureCount === 0
    || (invalidFailureIdentityCount === 0
      && duplicateFailureIdentityCount === 0
      && previousSnapshotIdentityCollisionCount === 0
      && reusedDetailCount === detailFailureCount);
  const canPublish = withinGrace
    && invalidFailureIdentityCount === 0
    && duplicateFailureIdentityCount === 0
    && (!requireReuse || fullyReused);

  return {
    rows,
    attemptedCount: attempted,
    detailFailureCount,
    detailFailureIdentities: failureIdentities,
    reusedDetailCount,
    reusedDetailIdentities,
    previousSnapshotIdentityCollisionCount,
    invalidFailureIdentityCount,
    duplicateFailureIdentityCount,
    withinGrace,
    fullyReused,
    canPublish,
  };
}
