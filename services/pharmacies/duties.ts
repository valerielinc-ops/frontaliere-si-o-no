import catalogueJson from '../../data/pharmacies-ticino-complete.json';
import {
  PHARMACY_RELEASE_REGION_KEYS,
  validatePharmacyReleaseContract,
  type PharmacyCatalogueDataset,
  type PharmacyDuty,
  type PharmacyDutyStatus,
  type PharmacyDutiesDataset,
  type PharmacyRegionKey,
  type PharmacyRegionReleaseStatus,
  type PharmacyReleaseContract,
  type PharmacyReleaseFreshness,
  type PharmacyReleaseState,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the existing monthly anagraphic SLA plus one missed refresh. */
export const PHARMACY_CATALOGUE_MAX_AGE_MS = 35 * DAY_MS;
/** Matches the daily duty source with the existing two-run tolerance. */
export const PHARMACY_DUTIES_MAX_AGE_MS = 2 * DAY_MS;

const CURRENT_CATALOGUE = catalogueJson as unknown as PharmacyCatalogueDataset;

export interface PharmacyReleaseEvaluation {
  state: PharmacyReleaseState;
  releaseId: string | null;
  publishable: boolean;
  reasons: string[];
  regions: Record<PharmacyRegionKey, PharmacyRegionReleaseStatus>;
}

export interface RuntimeDutyState {
  status: PharmacyDutyStatus;
  active: boolean;
  expired: boolean;
  startsAt: Date;
  endsAt: Date;
}

function freshnessFor(fetchedAt: unknown, nowMs: number, maxAgeMs: number): PharmacyReleaseFreshness {
  if (!Number.isFinite(nowMs)) return 'unknown';
  if (typeof fetchedAt !== 'string') return 'unknown';
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return 'unknown';
  const ageMs = nowMs - parsed;
  return ageMs < 0 || ageMs > maxAgeMs ? 'stale' : 'fresh';
}

function unknownRegionStatus(key: PharmacyRegionKey): PharmacyRegionReleaseStatus {
  return {
    name: key,
    sourceUrl: '',
    dutyCount: 0,
    fetchedAt: null,
    freshness: 'unknown',
    coverage: 'unknown',
    state: 'unknown',
    preserved: false,
  };
}

function unknownRegions(): Record<PharmacyRegionKey, PharmacyRegionReleaseStatus> {
  return Object.fromEntries(PHARMACY_RELEASE_REGION_KEYS.map((key) => [key, unknownRegionStatus(key)])) as Record<PharmacyRegionKey, PharmacyRegionReleaseStatus>;
}

function contractSnapshotsMatch(left: PharmacyReleaseContract, right: PharmacyReleaseContract): boolean {
  return left.releaseId === right.releaseId
    && left.version === right.version
    && left.timezone === right.timezone
    && left.snapshots.catalogue.path === right.snapshots.catalogue.path
    && left.snapshots.catalogue.sha256 === right.snapshots.catalogue.sha256
    && left.snapshots.catalogue.fetchedAt === right.snapshots.catalogue.fetchedAt
    && left.snapshots.duties.path === right.snapshots.duties.path
    && left.snapshots.duties.sha256 === right.snapshots.duties.sha256
    && left.snapshots.duties.fetchedAt === right.snapshots.duties.fetchedAt
    && left.scope.country === right.scope.country
    && left.scope.canton === right.scope.canton
    && left.scope.regions.length === right.scope.regions.length
    && left.scope.regions.every((region, index) => region === right.scope.regions[index]);
}

function regionState(
  base: PharmacyRegionReleaseStatus,
  duties: PharmacyDuty[],
  snapshotFreshness: PharmacyReleaseFreshness,
  nowMs: number,
): PharmacyReleaseState {
  if (base.state === 'conflicting' || duties.some((duty) => duty.status === 'conflicting')) return 'conflicting';
  if (base.preserved || base.coverage === 'partial') return 'partial';
  if (base.coverage === 'not_published' || duties.length === 0) return 'not_published';
  if (base.coverage === 'unknown') return 'unknown';
  if (snapshotFreshness === 'unknown') return 'unknown';
  if (snapshotFreshness === 'stale') return 'stale';

  const endTimes = duties.map((duty) => Date.parse(duty.endsAt));
  if (endTimes.every((end) => Number.isFinite(end) && end <= nowMs)) return 'expired';
  if (base.state === 'expired') return 'expired';
  if (base.state === 'stale') return 'stale';
  if (base.state === 'unknown') return 'unknown';
  if (!duties.some((duty) => duty.status === 'verified' && Number.isFinite(Date.parse(duty.endsAt)) && Date.parse(duty.endsAt) > nowMs)) {
    return 'partial';
  }
  return 'fresh';
}

/**
 * Evaluates the atomic catalogue+duties contract against the current clock.
 * `catalogue` defaults to the snapshot imported by the current build, so a
 * catalogue refresh cannot silently remain paired with an older duty file.
 */
export function getPharmacyReleaseEvaluation(
  dataset: PharmacyDutiesDataset,
  now: Date = new Date(),
  catalogue: PharmacyCatalogueDataset = CURRENT_CATALOGUE,
): PharmacyReleaseEvaluation {
  const dutyRelease = dataset?._release;
  const catalogueRelease = catalogue?._release;
  const dutyErrors = validatePharmacyReleaseContract(dutyRelease);
  const catalogueErrors = validatePharmacyReleaseContract(catalogueRelease);
  if (dutyErrors.length > 0 || catalogueErrors.length > 0 || !Array.isArray(dataset?.duties) || !Array.isArray(catalogue?.pharmacies)) {
    return {
      state: 'unknown',
      releaseId: null,
      publishable: false,
      reasons: [
        ...(dutyErrors.length > 0 ? ['duties release contract is invalid or missing'] : []),
        ...(catalogueErrors.length > 0 ? ['catalogue release contract is invalid or missing'] : []),
        ...(!Array.isArray(dataset?.duties) ? ['duties snapshot is invalid or missing'] : []),
        ...(!Array.isArray(catalogue?.pharmacies) ? ['catalogue snapshot is invalid or missing'] : []),
      ],
      regions: unknownRegions(),
    };
  }

  const nowMs = now.getTime();
  const dutyFetchedAt = dataset?._fetchedAt ?? null;
  const catalogueFetchedAt = catalogue?._fetchedAt ?? null;
  const dutyFreshness = freshnessFor(dutyFetchedAt, nowMs, PHARMACY_DUTIES_MAX_AGE_MS);
  const catalogueFreshness = freshnessFor(catalogueFetchedAt, nowMs, PHARMACY_CATALOGUE_MAX_AGE_MS);
  const reasons: string[] = [];
  const contractsMatch = contractSnapshotsMatch(dutyRelease, catalogueRelease)
    && dutyRelease.snapshots.duties.fetchedAt === dutyFetchedAt
    && catalogueRelease.snapshots.catalogue.fetchedAt === catalogueFetchedAt;
  if (!contractsMatch) reasons.push('catalogue and duties release metadata do not match');
  if (catalogueFreshness === 'unknown') reasons.push('catalogue freshness is unknown');
  if (dutyFreshness === 'unknown') reasons.push('duties freshness is unknown');
  if (catalogueFreshness === 'stale') reasons.push('catalogue snapshot is stale');
  if (dutyFreshness === 'stale') reasons.push('duties snapshot is stale');

  const regions = {} as Record<PharmacyRegionKey, PharmacyRegionReleaseStatus>;
  for (const key of PHARMACY_RELEASE_REGION_KEYS) {
    const base = dutyRelease.regions[key];
    const regionDuties = dataset.duties.filter((duty) => duty.coverageName === base.name);
    const regionFreshness = freshnessFor(base.fetchedAt, nowMs, PHARMACY_DUTIES_MAX_AGE_MS);
    const effectiveFreshness: PharmacyReleaseFreshness = dutyFreshness === 'unknown' || regionFreshness === 'unknown'
      ? 'unknown'
      : dutyFreshness === 'stale' || regionFreshness === 'stale'
        ? 'stale'
        : 'fresh';
    regions[key] = {
      ...base,
      freshness: effectiveFreshness,
      state: regionState(base, regionDuties, effectiveFreshness, nowMs),
    };
    if (regions[key].state !== 'fresh') reasons.push(`${key}: ${regions[key].state}`);
  }

  let state: PharmacyReleaseState = 'fresh';
  if (!contractsMatch) state = 'conflicting';
  else if (catalogueFreshness === 'unknown' || dutyFreshness === 'unknown') state = 'unknown';
  else if (catalogueFreshness === 'stale' || dutyFreshness === 'stale') state = 'stale';
  else {
    const states = Object.values(regions).map((region) => region.state);
    if (states.includes('conflicting')) state = 'conflicting';
    else if (states.every((regionStateValue) => regionStateValue === 'not_published')) state = 'not_published';
    else if (states.every((regionStateValue) => regionStateValue === 'expired')) state = 'expired';
    else if (states.some((regionStateValue) => regionStateValue !== 'fresh')) state = 'partial';
  }

  return {
    state,
    releaseId: dutyRelease.releaseId,
    publishable: contractsMatch && catalogueFreshness === 'fresh' && dutyFreshness === 'fresh',
    reasons,
    regions,
  };
}

export function getRuntimeDutyState(duty: PharmacyDuty, now: Date = new Date()): RuntimeDutyState {
  const startsAt = new Date(duty.startsAt);
  const endsAt = new Date(duty.endsAt);
  const expired = !Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime();
  const active = duty.status === 'verified'
    && !expired
    && Number.isFinite(startsAt.getTime())
    && startsAt.getTime() <= now.getTime();
  return {
    status: expired && duty.status === 'verified' ? 'expired' : duty.status,
    active,
    expired,
    startsAt,
    endsAt,
  };
}

export function isDutyCurrentlyActive(duty: PharmacyDuty, now: Date = new Date()): boolean {
  return getRuntimeDutyState(duty, now).active;
}

export function publicDutiesForRegion(
  dataset: PharmacyDutiesDataset,
  coverageName: string,
  now: Date = new Date(),
  catalogue: PharmacyCatalogueDataset = CURRENT_CATALOGUE,
): PharmacyDuty[] {
  const evaluation = getPharmacyReleaseEvaluation(dataset, now, catalogue);
  const region = Object.values(evaluation.regions).find((candidate) => candidate.name === coverageName);
  if (!evaluation.publishable || region?.state !== 'fresh') return [];
  return dataset.duties
    .filter((duty) => duty.coverageName === coverageName)
    .filter((duty) => duty.status === 'verified' && !getRuntimeDutyState(duty, now).expired)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function currentDutyForRegion(
  dataset: PharmacyDutiesDataset,
  coverageName: string,
  now: Date = new Date(),
  catalogue: PharmacyCatalogueDataset = CURRENT_CATALOGUE,
): PharmacyDuty | undefined {
  return publicDutiesForRegion(dataset, coverageName, now, catalogue)
    .find((duty) => isDutyCurrentlyActive(duty, now));
}
