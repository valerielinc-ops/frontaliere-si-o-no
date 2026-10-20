/**
 * Ordering guard for deploy_registry/last_known_good.
 *
 * Once Pages deploy and dist validation use separate concurrency locks, their
 * post-deploy tails can finish out of order. GitHub Actions run IDs are
 * monotonically increasing within this repository, so an older tail must not
 * overwrite the rollback target written by a newer validated build.
 */

function numericRunId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * @param {string|number|null|undefined} currentRunId
 * @param {string|number|null|undefined} candidateRunId
 * @returns {boolean}
 */
export function shouldAdvanceLastKnownGood(currentRunId, candidateRunId) {
  const candidate = numericRunId(candidateRunId);
  if (candidate === null) return false;

  const current = numericRunId(currentRunId);
  return current === null || candidate >= current;
}
