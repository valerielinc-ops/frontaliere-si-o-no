/**
 * Version of the evidence rules a validation report was graded against.
 * Bump a crawler spec's version when a quality rule changes in a way that can
 * invalidate its older proof; the promotion gate then requires fresh reports.
 */
export function qualityContractVersionOf(value = {}) {
  const version = Number(value?.qualityContractVersion);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

/**
 * Persist a spec's non-default quality contract on its candidate before
 * status filtering. This also reaches candidates currently `promoting`, whose
 * validation is deferred until their open PR is reconciled.
 *
 * @param {Record<string, any>|null|undefined} candidate
 * @param {Record<string, any>} spec
 * @returns {number}
 */
export function alignCandidateQualityContractVersion(candidate, spec = {}) {
  const version = qualityContractVersionOf(spec);
  if (candidate && (version > 1
    || Object.prototype.hasOwnProperty.call(candidate, 'qualityContractVersion'))) {
    candidate.qualityContractVersion = version;
  }
  return version;
}
