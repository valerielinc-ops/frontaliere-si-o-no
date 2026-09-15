import { createHash } from 'node:crypto';

export const ITALY_DUTY_RELEASE_VERSION = 1 as const;
export const ITALY_DUTY_RELEASE_TIMEZONE = 'Europe/Rome' as const;
export const ITALY_DUTY_RELEASE_PROVINCES = ['CO', 'VA', 'VB'] as const;
export const ITALY_DUTY_RELEASE_PREFIX = 'pharmacy-italy-v1-' as const;

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
type Snapshot = Record<string, unknown> & { _release?: unknown; _fetchedAt?: unknown };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release payload contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])) as { [key: string]: JsonValue };
  }
  throw new Error(`release payload contains unsupported value ${typeof value}`);
}

export function canonicalItalyDutyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256ItalyDutyPayload(value: unknown): string {
  return createHash('sha256').update(canonicalItalyDutyJson(value)).digest('hex');
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
  if (dutiesRelease.snapshots && isRecord(dutiesRelease.snapshots.duties)
    && dutiesRelease.snapshots.duties.sha256 !== expectedDutiesHash) errors.push('duties payload hash mismatch');
  if (dutiesRelease.snapshots && isRecord(dutiesRelease.snapshots.status)
    && dutiesRelease.snapshots.status.sha256 !== expectedStatusHash) errors.push('status payload hash mismatch');

  const evaluatedAt = typeof dutiesRelease.evaluatedAt === 'string' ? dutiesRelease.evaluatedAt : '';
  if (evaluatedAt) {
    const expected = buildItalyDutyRelease({ duties: payloadWithoutRelease(duties), status: payloadWithoutRelease(status), evaluatedAt });
    if (expected.releaseId !== dutiesRelease.releaseId) errors.push('releaseId does not match the release contract');
    if (canonicalItalyDutyJson({ ...expected, releaseId: undefined }) !== canonicalItalyDutyJson({ ...dutiesRelease, releaseId: undefined })) {
      errors.push('release metadata does not match the payload contract');
    }
  }
  return errors;
}

export function isItalyDutyReleasePublishable({ duties, status }: { duties: Snapshot; status: Snapshot }): boolean {
  const release = duties?._release;
  return isRecord(release) && release.state === 'fresh' && verifyItalyDutyRelease({ duties, status }).length === 0;
}
