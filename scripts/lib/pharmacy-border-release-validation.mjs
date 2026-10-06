/**
 * Dependency-free release metadata checks for the border pharmacy snapshots.
 *
 * The scheduled pharmacy health monitor uses these checks through
 * `check-pharmacy-border-data.mjs`, but runs without `npm ci`. Keep the
 * release contract helpers independent from the importer and its enrichment
 * providers so the monitor can validate checked-in snapshots at module load.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json-digest.mjs';

export const CATALOGUE_SNAPSHOT_PATH = 'data/pharmacies-ticino-complete.json';
export const DUTIES_SNAPSHOT_PATH = 'data/pharmacy-duties-ticino.json';

// Floors deliberately leave room below the current snapshots (207 Ticino;
// 542 Italy: CO 193, VA 266, VB 83) while rejecting the partial feeds that
// otherwise look like a successful refresh. Keep these values in one place so
// the importer and its integrity checker enforce the same declared perimeter.
export const BORDER_MINIMUMS = Object.freeze({
  ticino: 200,
  italy: 400,
  italyByProvince: Object.freeze({ CO: 150, VA: 200, VB: 50 }),
});

function snapshotPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const { _release: _ignoredRelease, ...payload } = snapshot;
  return payload;
}

export function pharmacySnapshotSha256(snapshot) {
  return createHash('sha256')
    .update(canonicalJson(snapshotPayload(snapshot) ?? null))
    .digest('hex');
}

export function releaseIdForContract(contract) {
  const { releaseId: _ignoredReleaseId, ...digestInput } = contract;
  return `pharmacy-v1-${createHash('sha256').update(canonicalJson(digestInput)).digest('hex')}`;
}

export function contractWithoutReleaseId(contract) {
  const { releaseId: _ignoredReleaseId, ...digestInput } = contract;
  return digestInput;
}

/**
 * Recomputes both payload hashes and the release digest from the files that
 * would be published. Metadata is deliberately excluded from each payload
 * hash, while the release digest covers the complete semantic contract except
 * for the digest field itself.
 */
export function verifyPharmacyReleaseContract({ catalogue, duties, status }) {
  const errors = [];
  const catalogueRelease = catalogue?._release;
  const dutiesRelease = duties?._release;
  if (!catalogueRelease || typeof catalogueRelease !== 'object') errors.push('catalogue release metadata is missing');
  if (!dutiesRelease || typeof dutiesRelease !== 'object') errors.push('duties release metadata is missing');
  if (errors.length > 0) return errors;

  const catalogueFetchedAt = typeof catalogue?._fetchedAt === 'string' ? catalogue._fetchedAt : null;
  const dutiesFetchedAt = typeof duties?._fetchedAt === 'string' ? duties._fetchedAt : null;
  const expectedSnapshots = {
    catalogue: {
      path: CATALOGUE_SNAPSHOT_PATH,
      sha256: pharmacySnapshotSha256(catalogue),
      fetchedAt: catalogueFetchedAt,
    },
    duties: {
      path: DUTIES_SNAPSHOT_PATH,
      sha256: pharmacySnapshotSha256(duties),
      fetchedAt: dutiesFetchedAt,
    },
  };
  const releaseEntries = [
    ['catalogue', catalogueRelease],
    ['duties', dutiesRelease],
    ...(status === undefined ? [] : [['duty status', status?._release]]),
  ];
  for (const [label, release] of releaseEntries) {
    if (!release || typeof release !== 'object') {
      errors.push(`${label} release metadata is missing`);
      continue;
    }
    let expectedReleaseId;
    try {
      expectedReleaseId = releaseIdForContract({ ...release, snapshots: expectedSnapshots });
    } catch {
      errors.push(`${label} release metadata is not canonical`);
      continue;
    }
    if (release.releaseId !== expectedReleaseId) {
      errors.push(`${label} releaseId does not match the payload digest`);
    }
    try {
      if (canonicalJson(release.snapshots) !== canonicalJson(expectedSnapshots)) {
        errors.push(`${label} snapshot hashes or timestamps do not match the payloads`);
      }
    } catch {
      errors.push(`${label} release snapshot metadata is not canonical`);
    }
  }
  if (catalogueRelease.releaseId !== dutiesRelease.releaseId) {
    errors.push('catalogue and duties releaseId values differ');
  }
  const referenceRelease = catalogueRelease;
  for (const [label, release] of releaseEntries.slice(1)) {
    if (!release || typeof release !== 'object') continue;
    try {
      if (canonicalJson(contractWithoutReleaseId(referenceRelease)) !== canonicalJson(contractWithoutReleaseId(release))) {
        errors.push(`catalogue and ${label} release contract semantics differ`);
      }
    } catch {
      errors.push(`catalogue and ${label} release contract is not canonical`);
    }
  }
  return errors;
}
