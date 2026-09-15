import { sha256 } from '@noble/hashes/sha256';
import italyCatalogueJson from '../../data/pharmacies-italy-border.json';
import italySourcesJson from '../../data/pharmacy-duties-italy-sources.json';
import { validatePharmacyDutyList } from './types';

export const ITALY_DUTY_RELEASE_VERSION = 1 as const;
export const ITALY_DUTY_RELEASE_TIMEZONE = 'Europe/Rome' as const;
export const ITALY_DUTY_RELEASE_PROVINCES = ['CO', 'VA', 'VB'] as const;
export const ITALY_DUTY_RELEASE_PREFIX = 'pharmacy-italy-v1-' as const;
/** The Italy connector contract allows three days between source refreshes. */
export const ITALY_DUTY_RELEASE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type ItalyDutyProvince = (typeof ITALY_DUTY_RELEASE_PROVINCES)[number];
export type ItalyDutyReleaseState = 'unknown' | 'fresh' | 'stale' | 'partial' | 'conflicting' | 'not_published';

export interface ItalyDutyReleaseSnapshot {
  path: string;
  sha256: string;
  fetchedAt: string | null;
}

export interface ItalyDutyRelease {
  version: typeof ITALY_DUTY_RELEASE_VERSION;
  releaseId: string;
  timezone: typeof ITALY_DUTY_RELEASE_TIMEZONE;
  state: ItalyDutyReleaseState;
  evaluatedAt: string;
  scope: {
    country: 'IT';
    provinces: readonly ItalyDutyProvince[];
  };
  snapshots: {
    duties: ItalyDutyReleaseSnapshot;
    status: ItalyDutyReleaseSnapshot;
  };
  provinces: Record<ItalyDutyProvince, Record<string, unknown>>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ItalyDutySnapshot = Record<string, unknown> & { _release?: unknown; _fetchedAt?: unknown };
type Snapshot = ItalyDutySnapshot;

export type ItalyDutyProvinceFreshness = 'fresh' | 'stale' | 'unknown';
export type ItalyDutyProvinceCoverage = 'covered' | 'partial' | 'not_published' | 'unknown';

export interface ItalyDutyProvinceEvaluation {
  province: ItalyDutyProvince;
  state: ItalyDutyReleaseState;
  freshness: ItalyDutyProvinceFreshness;
  coverage: ItalyDutyProvinceCoverage;
  dutyCount: number;
  observedDutyCount: number;
  sourceUrl: string | null;
  fetchedAt: string | null;
}

export interface ItalyDutyReleaseEvaluation {
  state: ItalyDutyReleaseState;
  releaseId: string | null;
  fetchedAt: string | null;
  publishable: boolean;
  reasons: string[];
  provinces: Record<ItalyDutyProvince, ItalyDutyProvinceEvaluation>;
}

type ItalyDutySourceDescriptor = {
  key: string;
  province: ItalyDutyProvince;
  name: string;
  sourceType: 'official';
  officialSourceUrl: string;
};

type ItalyDutySourceRegistry = {
  byProvince: Map<ItalyDutyProvince, ItalyDutySourceDescriptor>;
  errors: string[];
};

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release payload contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)] as [string, JsonValue]);
    return Object.fromEntries(entries) as { [key: string]: JsonValue };
  }
  throw new Error(`release payload contains unsupported value ${typeof value}`);
}

export function canonicalItalyDutyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256ItalyDutyPayload(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(canonicalItalyDutyJson(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function payloadWithoutRelease(snapshot: Snapshot): Record<string, unknown> {
  const { _release: _ignored, ...payload } = snapshot;
  return payload;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function statusEntries(status: Snapshot): Record<ItalyDutyProvince, Record<string, unknown>> {
  const entries = (status._provinces && typeof status._provinces === 'object' && !Array.isArray(status._provinces))
    ? status._provinces as Record<string, Record<string, unknown>>
    : {};
  return Object.fromEntries(ITALY_DUTY_RELEASE_PROVINCES.map((province) => [province, entries[province] || {
    province,
    state: 'not_published',
    freshness: 'unknown',
    coverage: 'not_published',
    dutyCount: 0,
    sourceUrl: '',
    fetchedAt: null,
  }])) as Record<ItalyDutyProvince, Record<string, unknown>>;
}

function deriveState(duties: Snapshot, status: Snapshot, provinces: Record<ItalyDutyProvince, Record<string, unknown>>): ItalyDutyReleaseState {
  const errors = [
    ...(Array.isArray(duties._errors) ? duties._errors : []),
    ...(Array.isArray(status._errors) ? status._errors : []),
  ];
  const entries = Object.values(provinces);
  if (status._allSourcesFailed === true || entries.every((entry) => entry.coverage === 'not_published')) return 'not_published';
  if (errors.length > 0 || entries.some((entry) => entry.state === 'conflicting')) return 'partial';
  if (entries.some((entry) => entry.freshness === 'stale')) return 'stale';
  if (entries.some((entry) => entry.coverage !== 'covered' || entry.freshness !== 'fresh')) return 'not_published';
  return 'fresh';
}

function releaseBody({ duties, status, evaluatedAt }: {
  duties: Snapshot;
  status: Snapshot;
  evaluatedAt: string;
}): Omit<ItalyDutyRelease, 'releaseId'> {
  const provinces = statusEntries(status);
  return {
    version: ITALY_DUTY_RELEASE_VERSION,
    timezone: ITALY_DUTY_RELEASE_TIMEZONE,
    state: deriveState(duties, status, provinces),
    evaluatedAt,
    scope: {
      country: 'IT',
      provinces: [...ITALY_DUTY_RELEASE_PROVINCES],
    },
    snapshots: {
      duties: {
        path: 'data/pharmacy-duties-italy.json',
        sha256: sha256ItalyDutyPayload(payloadWithoutRelease(duties)),
        fetchedAt: isoOrNull(duties._fetchedAt),
      },
      status: {
        path: 'data/pharmacy-duties-italy-status.json',
        sha256: sha256ItalyDutyPayload(payloadWithoutRelease(status)),
        fetchedAt: isoOrNull(status._fetchedAt),
      },
    },
    provinces,
  };
}

function addReleaseId(body: Omit<ItalyDutyRelease, 'releaseId'>): ItalyDutyRelease {
  const digest = sha256ItalyDutyPayload(body);
  return { ...body, releaseId: `${ITALY_DUTY_RELEASE_PREFIX}${digest}` };
}

export function buildItalyDutyRelease({
  duties,
  status,
  evaluatedAt = new Date().toISOString(),
}: {
  duties: Snapshot;
  status: Snapshot;
  evaluatedAt?: string;
}): ItalyDutyRelease {
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error('evaluatedAt must be an ISO timestamp');
  return addReleaseId(releaseBody({ duties, status, evaluatedAt }));
}

export function buildAtomicItalyDutySnapshots({
  duties,
  status,
  evaluatedAt,
}: {
  duties: Snapshot;
  status: Snapshot;
  evaluatedAt: string;
}) {
  const cleanDuties = payloadWithoutRelease(duties);
  const cleanStatus = payloadWithoutRelease(status);
  const release = buildItalyDutyRelease({ duties: cleanDuties, status: cleanStatus, evaluatedAt });
  return {
    duties: { ...cleanDuties, _release: release },
    status: { ...cleanStatus, _release: release },
    release,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSnapshot(label: string, snapshot: unknown, errors: string[]) {
  if (!isRecord(snapshot)) {
    errors.push(`${label}: expected an object`);
    return;
  }
  if (typeof snapshot.path !== 'string' || snapshot.path.trim() === '') errors.push(`${label}.path: missing`);
  if (typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) errors.push(`${label}.sha256: invalid`);
  if (snapshot.fetchedAt !== null && (typeof snapshot.fetchedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.fetchedAt)))) {
    errors.push(`${label}.fetchedAt: invalid`);
  }
}

export function validateItalyDutyRelease(release: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(release)) return ['release: expected an object'];
  if (release.version !== ITALY_DUTY_RELEASE_VERSION) errors.push('release.version: unsupported');
  if (typeof release.releaseId !== 'string' || !new RegExp(`^${ITALY_DUTY_RELEASE_PREFIX}[a-f0-9]{64}$`).test(release.releaseId)) errors.push('release.releaseId: invalid');
  if (release.timezone !== ITALY_DUTY_RELEASE_TIMEZONE) errors.push(`release.timezone: must be ${ITALY_DUTY_RELEASE_TIMEZONE}`);
  if (!['unknown', 'fresh', 'stale', 'partial', 'conflicting', 'not_published'].includes(String(release.state))) errors.push('release.state: invalid');
  if (typeof release.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(release.evaluatedAt))) errors.push('release.evaluatedAt: invalid');

  if (!isRecord(release.scope) || release.scope.country !== 'IT' || !Array.isArray(release.scope.provinces)
    || canonicalItalyDutyJson(release.scope.provinces) !== canonicalItalyDutyJson([...ITALY_DUTY_RELEASE_PROVINCES])) {
    errors.push('release.scope: must be IT/CO,VA,VB');
  }
  if (!isRecord(release.snapshots)) {
    errors.push('release.snapshots: missing');
  } else {
    validateSnapshot('release.snapshots.duties', release.snapshots.duties, errors);
    validateSnapshot('release.snapshots.status', release.snapshots.status, errors);
  }
  if (!isRecord(release.provinces)) {
    errors.push('release.provinces: missing');
  } else {
    for (const province of ITALY_DUTY_RELEASE_PROVINCES) {
      if (!isRecord(release.provinces[province])) errors.push(`release.provinces.${province}: missing`);
    }
  }
  return errors;
}

export function verifyItalyDutyRelease({ duties, status }: { duties: Snapshot; status: Snapshot }): string[] {
  const errors: string[] = [];
  const dutiesRelease = duties?._release;
  const statusRelease = status?._release;
  errors.push(...validateItalyDutyRelease(dutiesRelease).map((error) => `duties: ${error}`));
  errors.push(...validateItalyDutyRelease(statusRelease).map((error) => `status: ${error}`));
  if (!isRecord(dutiesRelease) || !isRecord(statusRelease)) return errors;
  if (dutiesRelease.releaseId !== statusRelease.releaseId) errors.push('releaseId differs between duties and status');

  const expectedDutiesHash = sha256ItalyDutyPayload(payloadWithoutRelease(duties));
  const expectedStatusHash = sha256ItalyDutyPayload(payloadWithoutRelease(status));
  const dutiesReleaseSnapshots = isRecord(dutiesRelease.snapshots) ? dutiesRelease.snapshots : {};
  const statusReleaseSnapshots = isRecord(statusRelease.snapshots) ? statusRelease.snapshots : {};
  const dutiesSnapshot = isRecord(dutiesReleaseSnapshots.duties) ? dutiesReleaseSnapshots.duties : null;
  const statusSnapshot = isRecord(dutiesReleaseSnapshots.status) ? dutiesReleaseSnapshots.status : null;
  const statusDutiesSnapshot = isRecord(statusReleaseSnapshots.duties) ? statusReleaseSnapshots.duties : null;
  const statusStatusSnapshot = isRecord(statusReleaseSnapshots.status) ? statusReleaseSnapshots.status : null;
  if (dutiesSnapshot?.sha256 !== expectedDutiesHash || statusDutiesSnapshot?.sha256 !== expectedDutiesHash) {
    errors.push('duties payload hash mismatch');
  }
  if (statusSnapshot?.sha256 !== expectedStatusHash || statusStatusSnapshot?.sha256 !== expectedStatusHash) {
    errors.push('status payload hash mismatch');
  }

  const evaluatedAt = typeof dutiesRelease.evaluatedAt === 'string' ? dutiesRelease.evaluatedAt : '';
  if (evaluatedAt) {
    const expected = buildItalyDutyRelease({ duties: payloadWithoutRelease(duties), status: payloadWithoutRelease(status), evaluatedAt });
    if (expected.releaseId !== dutiesRelease.releaseId) errors.push('releaseId does not match the release contract');
    if (canonicalItalyDutyJson({ ...expected, releaseId: undefined }) !== canonicalItalyDutyJson({ ...dutiesRelease, releaseId: undefined })) {
      errors.push('release metadata does not match the payload contract');
    }
    if (canonicalItalyDutyJson({ ...expected, releaseId: undefined }) !== canonicalItalyDutyJson({ ...statusRelease, releaseId: undefined })) {
      errors.push('status release metadata does not match the payload contract');
    }
  }
  return errors;
}

function releaseState(value: unknown): ItalyDutyReleaseState {
  return ['unknown', 'fresh', 'stale', 'partial', 'conflicting', 'not_published'].includes(String(value))
    ? value as ItalyDutyReleaseState
    : 'unknown';
}

function provinceFreshness(value: unknown): ItalyDutyProvinceFreshness {
  return value === 'fresh' || value === 'stale' || value === 'unknown' ? value : 'unknown';
}

function provinceCoverage(value: unknown): ItalyDutyProvinceCoverage {
  return value === 'covered' || value === 'partial' || value === 'not_published' || value === 'unknown'
    ? value
    : 'unknown';
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? value.trim() : null;
  } catch {
    return null;
  }
}

function isItalyDutyProvince(value: unknown): value is ItalyDutyProvince {
  return typeof value === 'string'
    && ITALY_DUTY_RELEASE_PROVINCES.includes(value as ItalyDutyProvince);
}

function catalogueRecords(catalogue: unknown): Record<string, unknown>[] {
  const raw = isRecord(catalogue) ? catalogue.pharmacies : catalogue;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function buildItalyDutySourceRegistry(sources: unknown): ItalyDutySourceRegistry {
  const raw = isRecord(sources) ? sources.sources : sources;
  const byProvince = new Map<ItalyDutyProvince, ItalyDutySourceDescriptor>();
  const errors: string[] = [];
  if (!isRecord(sources)) {
    errors.push('source registry: expected an object');
    return { byProvince, errors };
  }
  if (sources.version !== ITALY_DUTY_RELEASE_VERSION) errors.push('source registry: unsupported version');
  if (sources.timezone !== ITALY_DUTY_RELEASE_TIMEZONE) errors.push(`source registry timezone must be ${ITALY_DUTY_RELEASE_TIMEZONE}`);
  const scope = sources.scope;
  const expectedProvinces = [...ITALY_DUTY_RELEASE_PROVINCES];
  if (!isRecord(scope)
    || scope.country !== 'IT'
    || !Array.isArray(scope.provinces)
    || scope.provinces.length !== expectedProvinces.length
    || scope.provinces.some((province, index) => province !== expectedProvinces[index])) {
    errors.push('source registry scope must be IT/CO,VA,VB');
  }
  if (!Array.isArray(raw)) {
    errors.push('source registry: sources must be an array');
    return { byProvince, errors };
  }
  const entries = raw;

  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push('source[' + index + ']: expected an object');
      return;
    }
    const province = typeof entry.province === 'string' ? entry.province.toUpperCase() : '';
    if (!ITALY_DUTY_RELEASE_PROVINCES.includes(province as ItalyDutyProvince)) {
      errors.push('source[' + index + ']: unsupported Italian province');
      return;
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const sourceType = entry.sourceType;
    const officialSourceUrl = httpsUrl(entry.officialSourceUrl);
    if (!key || !name || sourceType !== 'official' || !officialSourceUrl) {
      errors.push('source[' + index + ']: invalid official source descriptor for ' + province);
      return;
    }
    if (byProvince.has(province as ItalyDutyProvince)) {
      errors.push('source[' + index + ']: duplicate official source for ' + province);
      return;
    }
    byProvince.set(province as ItalyDutyProvince, {
      key,
      province: province as ItalyDutyProvince,
      name,
      sourceType: 'official',
      officialSourceUrl,
    });
  });

  for (const province of ITALY_DUTY_RELEASE_PROVINCES) {
    if (!byProvince.has(province)) errors.push('source registry: missing official source for ' + province);
  }
  return { byProvince, errors };
}

function validateItalyDutyProvinceStatusEntries(
  status: Snapshot,
  sources: ItalyDutySourceRegistry,
): string[] {
  const entries = isRecord(status._provinces) ? status._provinces : {};
  const errors: string[] = [];
  for (const province of ITALY_DUTY_RELEASE_PROVINCES) {
    const entry = isRecord(entries[province]) ? entries[province] : null;
    const expected = sources.byProvince.get(province);
    if (!entry) {
      errors.push(province + ': province status is missing');
      continue;
    }
    if (entry.province !== province) errors.push(province + ': province status identity does not match its key');
    if (expected && entry.sourceKey !== expected.key) errors.push(province + ': source key does not match the official source registry');
    if (expected && entry.sourceUrl !== expected.officialSourceUrl) errors.push(province + ': source URL does not match the official source registry');
    if (!Array.isArray(entry.errors)) {
      errors.push(province + ': province status errors must be an array');
    } else if (entry.errors.length > 0) {
      errors.push(province + ': province status reports source errors');
    }
  }
  return errors;
}

function validateItalyDutyDiagnostics(duties: Snapshot, status: Snapshot): string[] {
  const errors: string[] = [];
  for (const [label, snapshot] of [['duties', duties], ['status', status]] as const) {
    if (!Array.isArray(snapshot._errors)) errors.push(`${label}: _errors must be an array`);
    if (!Array.isArray(snapshot._warnings)) errors.push(`${label}: _warnings must be an array`);
  }
  if (typeof status._allSourcesFailed !== 'boolean') errors.push('status: _allSourcesFailed must be a boolean');
  return errors;
}

function freshnessFor(value: unknown, nowMs: number, maxAgeMs: number): ItalyDutyProvinceFreshness {
  if (!Number.isFinite(nowMs) || typeof value !== 'string') return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const age = nowMs - parsed;
  return age < 0 || age > maxAgeMs ? 'stale' : 'fresh';
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function validateItalyDutyRows(
  rows: unknown[],
  now: Date,
  catalogue: unknown,
  sources: ItalyDutySourceRegistry,
): string[] {
  const errors = validatePharmacyDutyList(rows, now, { checkTemporalState: false });
  const records = catalogueRecords(catalogue);
  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    const province = isItalyDutyProvince(row.province) ? row.province : null;
    if (!province) {
      errors.push(`duty[${index}]: invalid Italian province`);
    }
    if (row.coverageType !== 'province') errors.push(`duty[${index}]: Italian duty must use province coverage`);
    if (row.status !== 'verified') errors.push(`duty[${index}]: Italian release rows must be verified`);

    const identityMatches = records.filter((record) => record.id === row.pharmacyId);
    if (identityMatches.length !== 1) {
      errors.push(`duty[${index}]: pharmacyId is missing or ambiguous in the Italian catalogue`);
    } else {
      const pharmacy = identityMatches[0];
      if (pharmacy.country !== 'IT' || pharmacy.province !== province) {
        errors.push(`duty[${index}]: pharmacyId province does not match the duty province`);
      }
    }

    const source = province ? sources.byProvince.get(province) : undefined;
    if (!source) {
      errors.push(`duty[${index}]: no unique official source is registered for ${province || 'unknown'}`);
    } else {
      if (row.coverageName !== source.name) errors.push(`duty[${index}]: coverageName does not match the official province source`);
      if (row.sourceUrl !== source.officialSourceUrl) errors.push(`duty[${index}]: sourceUrl does not match the official province source`);
      if (row.sourceType !== source.sourceType) errors.push(`duty[${index}]: sourceType does not match the official province source`);
    }
  });
  return errors;
}

/**
 * Runtime gate for the atomic Italy artifact. The checked-in `_release` is a
 * build-time claim; this evaluator additionally checks the clock, every
 * province status and the operational rows before a UI consumer can expose a
 * marker, source link or duty interval.
 */
export function evaluateItalyDutyRelease({
  duties,
  status,
  now = new Date(),
  maxAgeMs = ITALY_DUTY_RELEASE_MAX_AGE_MS,
  catalogue = italyCatalogueJson,
  sources = italySourcesJson,
}: {
  duties: unknown;
  status: unknown;
  now?: Date;
  maxAgeMs?: number;
  catalogue?: unknown;
  sources?: unknown;
}): ItalyDutyReleaseEvaluation {
  const dutiesRecord = isRecord(duties) ? duties as ItalyDutySnapshot : {};
  const statusRecord = isRecord(status) ? status as ItalyDutySnapshot : {};
  const release = isRecord(dutiesRecord._release) ? dutiesRecord._release : null;
  const releaseValue = releaseState(release?.state);
  const releaseId = typeof release?.releaseId === 'string' && release.releaseId.trim() ? release.releaseId : null;
  const reasons: string[] = [];
  let integrityErrors: string[] = [];
  try {
    integrityErrors = verifyItalyDutyRelease({ duties: dutiesRecord, status: statusRecord });
  } catch {
    integrityErrors = ['release verification threw while validating the artifact'];
  }
  if (integrityErrors.length > 0) reasons.push('Italy release integrity verification failed');

  const sourceRegistry = buildItalyDutySourceRegistry(sources);
  if (sourceRegistry.errors.length > 0) reasons.push('Italy duty source registry is invalid');
  const provinceStatusErrors = validateItalyDutyProvinceStatusEntries(statusRecord, sourceRegistry);
  if (provinceStatusErrors.length > 0) reasons.push('Italy status snapshot contains invalid province entries');
  const diagnosticErrors = validateItalyDutyDiagnostics(dutiesRecord, statusRecord);
  if (diagnosticErrors.length > 0) reasons.push('Italy snapshot diagnostics are malformed');

  const rawRows = dutiesRecord.duties;
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const rowErrors = validateItalyDutyRows(rows, now, catalogue, sourceRegistry);
  if (!Array.isArray(rawRows)) reasons.push('Italy duties snapshot is missing its duties array');
  if (rowErrors.length > 0) reasons.push('Italy duties snapshot contains invalid entries');

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const snapshotFreshness = [
    freshnessFor(dutiesRecord._fetchedAt, nowMs, maxAgeMs),
    freshnessFor(statusRecord._fetchedAt, nowMs, maxAgeMs),
  ];
  const globalFreshness: ItalyDutyProvinceFreshness = snapshotFreshness.includes('unknown')
    ? 'unknown'
    : snapshotFreshness.includes('stale') ? 'stale' : 'fresh';
  if (globalFreshness !== 'fresh') reasons.push(`Italy release freshness is ${globalFreshness}`);
  if (releaseValue !== 'fresh') reasons.push(`Italy release state is ${releaseValue}`);
  if (Array.isArray(dutiesRecord._errors) && dutiesRecord._errors.length > 0) reasons.push('Italy duties snapshot reports source errors');
  if (Array.isArray(statusRecord._errors) && statusRecord._errors.length > 0) reasons.push('Italy status snapshot reports source errors');
  if (statusRecord._allSourcesFailed === true) reasons.push('all Italian duty sources failed');

  const rawEntries = isRecord(statusRecord._provinces) ? statusRecord._provinces : {};
  const provinces = {} as Record<ItalyDutyProvince, ItalyDutyProvinceEvaluation>;
  let allProvincesReady = true;
  for (const province of ITALY_DUTY_RELEASE_PROVINCES) {
    const rawEntry = isRecord(rawEntries[province]) ? rawEntries[province] : null;
    const releaseEntry = isRecord(release?.provinces) && isRecord(release.provinces[province])
      ? release.provinces[province]
      : null;
    const entry = rawEntry || releaseEntry;
    const dutyRows = rows.filter((row): row is Record<string, unknown> => isRecord(row) && row.province === province);
    const entryFetchedAt = isoOrNull(entry?.fetchedAt);
    const entryFreshness = entry ? freshnessFor(entry.fetchedAt, nowMs, maxAgeMs) : 'unknown';
    const effectiveFreshness: ItalyDutyProvinceFreshness = globalFreshness === 'unknown' || entryFreshness === 'unknown'
      ? 'unknown'
      : globalFreshness === 'stale' || entryFreshness === 'stale' ? 'stale' : 'fresh';
    const dutyCount = nonNegativeInteger(entry?.dutyCount);
    const observedDutyCount = nonNegativeInteger(entry?.observedDutyCount);
    const expectedSource = sourceRegistry.byProvince.get(province);
    const provinceStatusValid = !provinceStatusErrors.some((error) => error.startsWith(province + ':'));
    const sourceIdentityValid = Boolean(expectedSource)
      && entry?.sourceKey === expectedSource.key
      && entry?.sourceUrl === expectedSource.officialSourceUrl;
    const evaluation: ItalyDutyProvinceEvaluation = {
      province,
      state: releaseState(entry?.state),
      freshness: effectiveFreshness,
      coverage: provinceCoverage(entry?.coverage),
      dutyCount,
      observedDutyCount,
      sourceUrl: httpsUrl(entry?.sourceUrl),
      fetchedAt: entryFetchedAt,
    };
    provinces[province] = evaluation;

    const ready = evaluation.state === 'fresh'
      && evaluation.freshness === 'fresh'
      && evaluation.coverage === 'covered'
      && evaluation.sourceUrl !== null
      && sourceIdentityValid
      && provinceStatusValid
      && evaluation.dutyCount > 0
      && dutyRows.length === evaluation.dutyCount;
    if (!ready) {
      allProvincesReady = false;
      if (!rawEntry) reasons.push(`${province}: province status is missing`);
      if (evaluation.state !== 'fresh') reasons.push(`${province}: ${evaluation.state}`);
      if (evaluation.coverage !== 'covered') reasons.push(`${province}: coverage is ${evaluation.coverage}`);
      if (evaluation.freshness !== 'fresh') reasons.push(`${province}: freshness is ${evaluation.freshness}`);
      if (evaluation.dutyCount === 0) reasons.push(`${province}: no operational duty rows are publishable`);
      else if (dutyRows.length !== evaluation.dutyCount) reasons.push(`${province}: duty count does not match the release status`);
      if (!evaluation.sourceUrl) reasons.push(`${province}: official source URL is missing or invalid`);
      if (!sourceIdentityValid) reasons.push(province + ': source identity does not match the official source registry');
      if (!provinceStatusValid) reasons.push(province + ': province status contains invalid or source errors');
    }
  }

  const publishable = releaseValue === 'fresh'
    && integrityErrors.length === 0
    && rowErrors.length === 0
    && sourceRegistry.errors.length === 0
    && provinceStatusErrors.length === 0
    && diagnosticErrors.length === 0
    && globalFreshness === 'fresh'
    && allProvincesReady
    && !(Array.isArray(dutiesRecord._errors) && dutiesRecord._errors.length > 0)
    && !(Array.isArray(statusRecord._errors) && statusRecord._errors.length > 0)
    && statusRecord._allSourcesFailed !== true;
  let state = releaseValue;
  if (integrityErrors.length > 0 || rowErrors.length > 0 || diagnosticErrors.length > 0) state = releaseValue === 'fresh' ? 'conflicting' : releaseValue;
  else if (releaseValue === 'fresh' && globalFreshness !== 'fresh') state = globalFreshness;
  else if (releaseValue === 'fresh' && !allProvincesReady) state = 'partial';
  if (!publishable && reasons.length === 0) reasons.push('Italy release is not publishable');

  return {
    state,
    releaseId,
    fetchedAt: isoOrNull(dutiesRecord._fetchedAt),
    publishable,
    reasons: [...new Set(reasons)],
    provinces,
  };
}

export function isItalyDutyReleasePublishable({ duties, status }: { duties: Snapshot; status: Snapshot }): boolean {
  return evaluateItalyDutyRelease({ duties, status }).publishable;
}
