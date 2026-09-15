import {
  validatePharmacyDutyList,
  type PharmacyDuty,
  type PharmacyDutyStatus,
} from './types';
import {
  GENEVA_DUTY_RELEASE_CANTON,
  GENEVA_DUTY_RELEASE_COVERAGE_NAME,
  GENEVA_DUTY_RELEASE_MAX_AGE_MS,
  GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS,
  GENEVA_DUTY_RELEASE_SOURCE_KEY,
  GENEVA_DUTY_RELEASE_SOURCE_URL,
  GENEVA_DUTY_RELEASE_TIMEZONE,
  GENEVA_DUTY_RELEASE_VALID_FROM,
  GENEVA_DUTY_RELEASE_VALID_TO,
  buildAtomicGenevaDutySnapshots,
  buildGenevaDutyRelease,
  canonicalGenevaDutyJson,
  sha256GenevaDutyPayload,
  validateGenevaDutyRelease,
  validateGenevaDutySourceRegistry,
  verifyGenevaDutyRelease,
} from './genevaReleaseContract.mjs';

export {
  GENEVA_DUTY_RELEASE_CANTON,
  GENEVA_DUTY_RELEASE_COVERAGE_NAME,
  GENEVA_DUTY_RELEASE_MAX_AGE_MS,
  GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS,
  GENEVA_DUTY_RELEASE_SOURCE_KEY,
  GENEVA_DUTY_RELEASE_SOURCE_URL,
  GENEVA_DUTY_RELEASE_TIMEZONE,
  GENEVA_DUTY_RELEASE_VALID_FROM,
  GENEVA_DUTY_RELEASE_VALID_TO,
  buildAtomicGenevaDutySnapshots,
  buildGenevaDutyRelease,
  canonicalGenevaDutyJson,
  sha256GenevaDutyPayload,
  validateGenevaDutyRelease,
  validateGenevaDutySourceRegistry,
  verifyGenevaDutyRelease,
};

export type GenevaDutyReleaseState =
  | 'unknown'
  | 'fresh'
  | 'stale'
  | 'partial'
  | 'conflicting'
  | 'not_published';
export type GenevaDutyFreshness = 'fresh' | 'stale' | 'unknown';
export type GenevaDutyCoverage = 'covered' | 'partial' | 'not_published' | 'unknown';

export type GenevaDutySnapshot = Record<string, unknown> & {
  duties?: unknown;
  _release?: unknown;
};

export interface GenevaDutyCataloguePharmacy {
  id: string;
  country: string;
  canton: string;
}

export interface GenevaDutyReleaseEvaluation {
  state: GenevaDutyReleaseState;
  releaseId: string | null;
  fetchedAt: string | null;
  freshness: GenevaDutyFreshness;
  coverage: GenevaDutyCoverage;
  publishable: boolean;
  indexable: boolean;
  reasons: string[];
}

type GenevaDutySourceRegistry = Record<string, unknown>;
type GenevaDutySource = Record<string, unknown>;

const RELEASE_STATES = new Set<GenevaDutyReleaseState>([
  'unknown',
  'fresh',
  'stale',
  'partial',
  'conflicting',
  'not_published',
]);
const COVERAGE_STATES = new Set<GenevaDutyCoverage>(['covered', 'partial', 'not_published', 'unknown']);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const GENEVA_CANTON_NAMES = new Set(['Geneva', 'Ginevra', GENEVA_DUTY_RELEASE_CANTON]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string'
    && ISO_TIMESTAMP_RE.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function releaseState(value: unknown): GenevaDutyReleaseState {
  return typeof value === 'string' && RELEASE_STATES.has(value as GenevaDutyReleaseState)
    ? value as GenevaDutyReleaseState
    : 'unknown';
}

function coverageState(value: unknown): GenevaDutyCoverage {
  return typeof value === 'string' && COVERAGE_STATES.has(value as GenevaDutyCoverage)
    ? value as GenevaDutyCoverage
    : 'unknown';
}

function freshnessFor(value: unknown, nowMs: number, maxAgeMs: number): GenevaDutyFreshness {
  const timestamp = isoOrNull(value);
  if (!timestamp || !Number.isFinite(nowMs)) return 'unknown';
  const age = nowMs - Date.parse(timestamp);
  return age < -60 * 60 * 1000 || age > maxAgeMs ? 'stale' : 'fresh';
}

function sourceOf(sources: unknown): GenevaDutySource | null {
  return isRecord(sources) && Array.isArray(sources.sources) && isRecord(sources.sources[0])
    ? sources.sources[0]
    : null;
}

function aliasIds(source: GenevaDutySource | null): Set<string> {
  if (!source || !Array.isArray(source.identityAliases)) return new Set();
  return new Set(source.identityAliases
    .filter(isRecord)
    .map((alias) => alias.pharmacyId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim()));
}

function validateGenevaDutyRows(
  rows: unknown[],
  now: Date,
  catalogue: unknown,
  source: GenevaDutySource | null,
): string[] {
  const errors = validatePharmacyDutyList(rows, now, { checkTemporalState: false });
  const records = Array.isArray(catalogue)
    ? catalogue.filter(isRecord)
    : [];
  const knownIds = aliasIds(source);

  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    if (row.coverageType !== 'canton') errors.push(`duty[${index}]: Geneva duty must use canton coverage`);
    if (row.coverageName !== GENEVA_DUTY_RELEASE_COVERAGE_NAME) errors.push(`duty[${index}]: coverageName must be Genève`);
    if (row.status !== 'verified') errors.push(`duty[${index}]: Geneva release rows must be verified`);
    if (row.sourceUrl !== GENEVA_DUTY_RELEASE_SOURCE_URL) errors.push(`duty[${index}]: sourceUrl does not match the allowlisted Pharma Genève source`);
    if (row.sourceType !== 'association') errors.push(`duty[${index}]: sourceType must be association`);
    if (typeof row.pharmacyId !== 'string' || !knownIds.has(row.pharmacyId)) {
      errors.push(`duty[${index}]: pharmacyId is not registered by the Geneva source identity aliases`);
    }

    const identityMatches = records.filter((record) => record.id === row.pharmacyId);
    if (identityMatches.length !== 1) {
      errors.push(`duty[${index}]: pharmacyId is missing or ambiguous in the Geneva catalogue`);
    } else {
      const pharmacy = identityMatches[0];
      if (pharmacy.country !== 'CH' || typeof pharmacy.canton !== 'string' || !GENEVA_CANTON_NAMES.has(pharmacy.canton)) {
        errors.push(`duty[${index}]: pharmacyId does not resolve to a Geneva Swiss catalogue record`);
      }
    }
  });
  return errors;
}

function validateGenevaDiagnostics(
  label: string,
  snapshot: GenevaDutySnapshot,
  rows: unknown[],
): string[] {
  const errors: string[] = [];
  if (snapshot._source !== GENEVA_DUTY_RELEASE_SOURCE_URL) errors.push(`${label}: _source must be the allowlisted Pharma Genève URL`);
  if (snapshot._sourceKey !== GENEVA_DUTY_RELEASE_SOURCE_KEY) errors.push(`${label}: _sourceKey is invalid`);
  if (snapshot._timezone !== GENEVA_DUTY_RELEASE_TIMEZONE) errors.push(`${label}: _timezone is invalid`);
  if (!isRecord(snapshot._scope) || snapshot._scope.country !== 'CH' || snapshot._scope.canton !== GENEVA_DUTY_RELEASE_CANTON) {
    errors.push(`${label}: _scope must be CH/GE`);
  }
  if (!Array.isArray(snapshot._errors) || snapshot._errors.some((error) => typeof error !== 'string')) {
    errors.push(`${label}: _errors must be an array of strings`);
  }
  if (!Array.isArray(snapshot._warnings) || snapshot._warnings.some((warning) => typeof warning !== 'string')) {
    errors.push(`${label}: _warnings must be an array of strings`);
  }
  if (snapshot._fetchedAt !== null && isoOrNull(snapshot._fetchedAt) === null) errors.push(`${label}: _fetchedAt is invalid`);
  if (!isRecord(snapshot._coverage)) {
    errors.push(`${label}: _coverage is missing`);
  } else {
    const coverage = snapshot._coverage;
    if (coverage.validFrom !== GENEVA_DUTY_RELEASE_VALID_FROM || coverage.validTo !== GENEVA_DUTY_RELEASE_VALID_TO) {
      errors.push(`${label}: _coverage window is not the declared 2026 calendar`);
    }
    if (coverage.minimumCalendarDays !== GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS) {
      errors.push(`${label}: _coverage minimumCalendarDays is invalid`);
    }
    if (!Number.isInteger(coverage.observedCalendarDays) || (coverage.observedCalendarDays as number) < 0) {
      errors.push(`${label}: _coverage observedCalendarDays is invalid`);
    }
    if (!Number.isInteger(coverage.uncoveredCalendarDays) || (coverage.uncoveredCalendarDays as number) < 0) {
      errors.push(`${label}: _coverage uncoveredCalendarDays is invalid`);
    }
    if (!COVERAGE_STATES.has(coverage.coverage as GenevaDutyCoverage)) errors.push(`${label}: _coverage coverage is invalid`);
  }
  if (typeof snapshot._allSourcesFailed !== 'boolean') errors.push(`${label}: _allSourcesFailed must be boolean`);
  if (typeof snapshot._releaseReady !== 'boolean') errors.push(`${label}: _releaseReady must be boolean`);
  if (typeof snapshot._state !== 'string' || !RELEASE_STATES.has(snapshot._state as GenevaDutyReleaseState)) {
    errors.push(`${label}: _state is invalid`);
  }
  if (!Number.isInteger(snapshot._observedEntryCount) || (snapshot._observedEntryCount as number) < 0) errors.push(`${label}: _observedEntryCount is invalid`);
  if (!Number.isInteger(snapshot._resolvedDutyCount) || (snapshot._resolvedDutyCount as number) < 0) errors.push(`${label}: _resolvedDutyCount is invalid`);
  if (snapshot._resolvedDutyCount !== rows.length) errors.push(`${label}: _resolvedDutyCount does not match the operational row count`);
  if (!Array.isArray(snapshot._unresolvedIdentities) || snapshot._unresolvedIdentities.some((identity) => typeof identity !== 'string' || !identity.trim())) {
    errors.push(`${label}: _unresolvedIdentities must be an array of non-empty strings`);
  }
  return errors;
}

/**
 * Runtime gate for the Geneva source-only artifact. It is deliberately
 * stricter than the parser: a consumer needs an intact release, an active
 * source, a complete contiguous calendar and catalogue-resolved identities.
 */
export function evaluateGenevaDutyRelease({
  duties,
  status,
  now = new Date(),
  maxAgeMs = GENEVA_DUTY_RELEASE_MAX_AGE_MS,
  catalogue = [],
  sources,
}: {
  duties: unknown;
  status: unknown;
  now?: Date;
  maxAgeMs?: number;
  catalogue?: unknown;
  sources: GenevaDutySourceRegistry;
}): GenevaDutyReleaseEvaluation {
  const dutiesRecord = isRecord(duties) ? duties as GenevaDutySnapshot : {};
  const statusRecord = isRecord(status) ? status as GenevaDutySnapshot : {};
  const release = isRecord(dutiesRecord._release) ? dutiesRecord._release : null;
  const releaseValue = releaseState(release?.state);
  const releaseId = typeof release?.releaseId === 'string' && release.releaseId.trim() ? release.releaseId : null;
  const reasons: string[] = [];
  let integrityErrors: string[] = [];
  try {
    integrityErrors = verifyGenevaDutyRelease({ duties: dutiesRecord, status: statusRecord, sources });
  } catch {
    integrityErrors = ['release verification threw while validating the artifact'];
  }
  if (integrityErrors.length > 0) reasons.push('Geneva release integrity verification failed');

  const sourceRegistryErrors = validateGenevaDutySourceRegistry(sources);
  if (sourceRegistryErrors.length > 0) reasons.push('Geneva duty source registry is invalid');
  const source = sourceOf(sources);
  const rawRows = dutiesRecord.duties;
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const dutiesDiagnosticErrors = validateGenevaDiagnostics('duties snapshot', dutiesRecord, rows);
  const statusDiagnosticErrors = validateGenevaDiagnostics('status snapshot', statusRecord, rows);
  if (dutiesDiagnosticErrors.length > 0 || statusDiagnosticErrors.length > 0) reasons.push('Geneva snapshot diagnostics are malformed');
  if (!Array.isArray(rawRows)) reasons.push('Geneva duties snapshot is missing its duties array');

  const rowErrors = validateGenevaDutyRows(rows, now, catalogue, source);
  if (rowErrors.length > 0) reasons.push('Geneva duties snapshot contains invalid entries');

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const freshnessValues = [
    freshnessFor(dutiesRecord._fetchedAt, nowMs, maxAgeMs),
    freshnessFor(statusRecord._fetchedAt, nowMs, maxAgeMs),
  ];
  const freshness: GenevaDutyFreshness = freshnessValues.includes('unknown')
    ? 'unknown'
    : freshnessValues.includes('stale') ? 'stale' : 'fresh';
  if (freshness !== 'fresh') reasons.push(`Geneva release freshness is ${freshness}`);

  const coverageRecord = isRecord(statusRecord._coverage) ? statusRecord._coverage : {};
  const coverage = coverageState(coverageRecord.coverage);
  if (coverage !== 'covered') reasons.push(`Geneva coverage is ${coverage}`);
  if (coverageRecord.observedCalendarDays !== GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS
    || coverageRecord.uncoveredCalendarDays !== 0) {
    reasons.push('Geneva calendar coverage is not a complete contiguous 2026 calendar');
  }
  if (source?.status !== 'active') reasons.push(`Geneva source status is ${typeof source?.status === 'string' ? source.status : 'unknown'}`);
  if (releaseValue !== 'fresh') reasons.push(`Geneva release state is ${releaseValue}`);
  if (Array.isArray(dutiesRecord._errors) && dutiesRecord._errors.length > 0) reasons.push('Geneva duties snapshot reports source errors');
  if (Array.isArray(statusRecord._errors) && statusRecord._errors.length > 0) reasons.push('Geneva status snapshot reports source errors');
  if (statusRecord._allSourcesFailed === true) reasons.push('all Geneva duty sources failed');
  if (statusRecord._releaseReady !== true) reasons.push('Geneva release is not marked release-ready');
  if (Array.isArray(statusRecord._unresolvedIdentities) && statusRecord._unresolvedIdentities.length > 0) reasons.push('Geneva duties have unresolved source identities');
  if (statusRecord._state !== releaseValue) reasons.push('Geneva status state does not match the release state');

  const publishable = releaseValue === 'fresh'
    && integrityErrors.length === 0
    && sourceRegistryErrors.length === 0
    && dutiesDiagnosticErrors.length === 0
    && statusDiagnosticErrors.length === 0
    && rowErrors.length === 0
    && freshness === 'fresh'
    && coverage === 'covered'
    && coverageRecord.observedCalendarDays === GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS
    && coverageRecord.uncoveredCalendarDays === 0
    && source?.status === 'active'
    && statusRecord._allSourcesFailed === false
    && Array.isArray(dutiesRecord._errors) && dutiesRecord._errors.length === 0
    && Array.isArray(statusRecord._errors) && statusRecord._errors.length === 0
    && Array.isArray(statusRecord._unresolvedIdentities) && statusRecord._unresolvedIdentities.length === 0
    && rows.length > 0;

  let state = releaseValue;
  if (integrityErrors.length > 0 || rowErrors.length > 0 || dutiesDiagnosticErrors.length > 0 || statusDiagnosticErrors.length > 0) {
    state = releaseValue === 'fresh' ? 'conflicting' : releaseValue;
  } else if (releaseValue === 'fresh' && freshness !== 'fresh') {
    state = freshness;
  } else if (releaseValue === 'fresh' && !publishable) {
    state = 'partial';
  }
  if (!publishable && reasons.length === 0) reasons.push('Geneva release is not publishable');

  return {
    state,
    releaseId,
    fetchedAt: isoOrNull(dutiesRecord._fetchedAt),
    freshness,
    coverage,
    publishable,
    indexable: publishable,
    reasons: [...new Set(reasons)],
  };
}

export function isGenevaDutyReleasePublishable(args: Parameters<typeof evaluateGenevaDutyRelease>[0]): boolean {
  return evaluateGenevaDutyRelease(args).publishable;
}

export type GenevaDutyContractRow = PharmacyDuty & { status: PharmacyDutyStatus };
