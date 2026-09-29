import cantonSnapshotJson from '../../data/pharmacy-duties-swiss-cantons.json';
import genevaCatalogueJson from '../../data/pharmacy-duties-geneva-catalogue.json';
import genevaDutiesJson from '../../data/pharmacy-duties-geneva.json';
import genevaSourcesJson from '../../data/pharmacy-duties-geneva-sources.json';
import genevaStatusJson from '../../data/pharmacy-duties-geneva-status.json';
import { evaluateGenevaDutyRelease } from './genevaRelease';
import { SWISS_CANTONS, type SwissCanton } from './swissCantons';
import type {
  PharmacyDutySourceType,
  PharmacySourceType,
  PharmacySourcesRegistry,
} from './types';

export const SWISS_CANTON_DUTY_TIMEZONE = 'Europe/Zurich' as const;
export const SWISS_CANTON_DUTY_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const SWISS_CANTON_DUTY_SCHEMA_VERSION = 1 as const;

export type SwissCantonDutyCoverageType = 'canton' | 'region';
export type SwissCantonDutyReleaseState = 'fresh' | 'stale' | 'partial' | 'unknown' | 'conflicting' | 'not_published';

export interface SwissCantonPharmacyIdentity {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly cantonCode: string;
  readonly country: 'CH';
  readonly sourceUrl: string;
  readonly sourceType: PharmacySourceType;
  readonly lastVerifiedAt: string;
}

export interface SwissCantonDuty {
  readonly id: string;
  readonly pharmacyId: string;
  readonly pharmacyName: string;
  readonly coverageType: SwissCantonDutyCoverageType;
  readonly coverageName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly dutyType: 'day' | 'night' | 'weekend' | 'holiday' | '24h';
  readonly status: 'verified' | 'expired';
  readonly sourceUrl: string;
  readonly sourceType: PharmacyDutySourceType;
  readonly fetchedAt: string;
  readonly verifiedAt?: string;
}

export interface SwissCantonDutySnapshot {
  readonly _schemaVersion: typeof SWISS_CANTON_DUTY_SCHEMA_VERSION;
  readonly _source: string;
  readonly _sourceKey: string;
  readonly _fetchedAt: string | null;
  readonly _attemptedAt: string;
  readonly _timezone: typeof SWISS_CANTON_DUTY_TIMEZONE;
  readonly _scope: {
    readonly country: 'CH';
    readonly canton: string;
    readonly coverageType: SwissCantonDutyCoverageType;
  };
  readonly _coverage: {
    readonly validFrom: string;
    readonly validTo: string;
    readonly observedCalendarDays: number;
    readonly uncoveredCalendarDays: number;
    readonly coverage: 'covered' | 'partial' | 'not_published' | 'unknown';
  };
  readonly _releaseReady: boolean;
  readonly _state: SwissCantonDutyReleaseState;
  readonly _release: {
    readonly version: typeof SWISS_CANTON_DUTY_SCHEMA_VERSION;
    readonly releaseId: string;
    readonly evaluatedAt: string;
    readonly state: SwissCantonDutyReleaseState;
    readonly source: { readonly key: string; readonly url: string };
    readonly scope: SwissCantonDutySnapshot['_scope'];
    readonly coverage: SwissCantonDutySnapshot['_coverage'];
  };
  readonly _errors: readonly string[];
  readonly _warnings: readonly string[];
  readonly _unresolvedIdentities: readonly string[];
  readonly coverageName: string;
  readonly pharmacies: readonly SwissCantonPharmacyIdentity[];
  readonly duties: readonly SwissCantonDuty[];
}

export interface SwissCantonOperationalCoverage {
  readonly code: string;
  readonly key: string;
  readonly name: string;
  readonly coverageType: SwissCantonDutyCoverageType;
  readonly coverageName: string;
  readonly sourceUrl: string;
  readonly sourceType: PharmacyDutySourceType;
  readonly fetchedAt: string;
  readonly releaseId: string;
  readonly duties: readonly SwissCantonDuty[];
}

export interface SwissCantonDutyCoverageResult {
  readonly operationalCantons: readonly SwissCantonOperationalCoverage[];
  readonly diagnostics: readonly string[];
}

export interface BuildSwissCantonDutyCoverageOptions {
  readonly now: Date;
  readonly weekStart: string;
  readonly registry: PharmacySourcesRegistry;
  readonly snapshots?: Readonly<Record<string, unknown>>;
  readonly includeGeneva?: boolean;
  readonly maxAgeMs?: number;
}

const DEFAULT_SNAPSHOTS = (cantonSnapshotJson as { snapshots?: Record<string, unknown> }).snapshots || {};
const DEFAULT_GENEVA_DUTIES = genevaDutiesJson as unknown;
const DEFAULT_GENEVA_STATUS = genevaStatusJson as unknown;
const DEFAULT_GENEVA_SOURCES = genevaSourcesJson as Record<string, unknown>;
const DEFAULT_GENEVA_CATALOGUE = (genevaCatalogueJson as { pharmacies?: unknown[] }).pharmacies || [];

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoTimestamp(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function safeHttpsUrl(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function sourceUrlMatchesRegistry(value: unknown, expected: string): boolean {
  const candidate = safeHttpsUrl(value);
  const registry = safeHttpsUrl(expected);
  if (!candidate || !registry) return false;
  try {
    return new URL(candidate).hostname === new URL(registry).hostname;
  } catch {
    return false;
  }
}

function cantonForCode(code: string): SwissCanton | null {
  return SWISS_CANTONS.find((canton) => canton.code === code) || null;
}

function weekEnd(weekStart: string): string | null {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function intersectsWeek(startsAt: string, endsAt: string, weekStart: string, weekEndKey: string): boolean {
  const starts = Date.parse(startsAt);
  const ends = Date.parse(endsAt);
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  const end = Date.parse(`${weekEndKey}T00:00:00.000Z`);
  return Number.isFinite(starts) && Number.isFinite(ends) && ends > starts && ends > start && starts < end;
}

function sourceForRegistry(registry: PharmacySourcesRegistry, canton: SwissCanton): PharmacySourcesRegistry['sources'][string] | null {
  return registry.sources?.[canton.key] || null;
}

function sourceIsActive(source: PharmacySourcesRegistry['sources'][string] | null): boolean {
  return source?.status === 'active';
}

function dutySourceTypeFor(source: PharmacySourcesRegistry['sources'][string] | null): PharmacyDutySourceType | null {
  const sourceType = source?.sourceType;
  return sourceType === 'official' || sourceType === 'association' || sourceType === 'pharmacy' || sourceType === 'verified_partner'
    ? sourceType
    : null;
}

function freshnessFor(fetchedAt: string | null, now: Date, maxAgeMs: number): 'fresh' | 'stale' | 'unknown' {
  if (!fetchedAt || !Number.isFinite(now.getTime())) return 'unknown';
  const age = now.getTime() - Date.parse(fetchedAt);
  return age < -60 * 60 * 1000 || age > maxAgeMs ? 'stale' : 'fresh';
}

function validDutyRows(snapshot: SwissCantonDutySnapshot, expectedSourceUrl: string, expectedSourceType: PharmacyDutySourceType): string[] {
  const errors: string[] = [];
  const identityIds = new Set<string>();
  snapshot.pharmacies.forEach((pharmacy, index) => {
    if (!pharmacy.id || identityIds.has(pharmacy.id)) errors.push(`pharmacy[${index}]: duplicate or empty id`);
    identityIds.add(pharmacy.id);
    if (!pharmacy.name?.trim() || !pharmacy.city?.trim()) errors.push(`pharmacy[${index}]: name or city is missing`);
    if (pharmacy.country !== 'CH' || pharmacy.cantonCode !== snapshot._scope.canton) errors.push(`pharmacy[${index}]: identity scope does not match canton`);
    if (!sourceUrlMatchesRegistry(pharmacy.sourceUrl, expectedSourceUrl)) errors.push(`pharmacy[${index}]: source URL is not the allowlisted source host`);
    if (!isoTimestamp(pharmacy.lastVerifiedAt)) errors.push(`pharmacy[${index}]: lastVerifiedAt is invalid`);
  });
  const identities = new Map(snapshot.pharmacies.map((pharmacy) => [pharmacy.id, pharmacy]));
  const seen = new Set<string>();
  snapshot.duties.forEach((duty, index) => {
    if (!duty.id || seen.has(duty.id)) errors.push(`duty[${index}]: duplicate or empty id`);
    seen.add(duty.id);
    if (!identities.has(duty.pharmacyId)) errors.push(`duty[${index}]: pharmacy identity is unresolved`);
    if (!duty.pharmacyName?.trim()) errors.push(`duty[${index}]: pharmacy name is missing`);
    if (!Number.isFinite(Date.parse(duty.startsAt)) || !Number.isFinite(Date.parse(duty.endsAt)) || Date.parse(duty.endsAt) <= Date.parse(duty.startsAt)) {
      errors.push(`duty[${index}]: interval is invalid`);
    }
    if (duty.status !== 'verified' && duty.status !== 'expired') errors.push(`duty[${index}]: status is invalid`);
    if (!sourceUrlMatchesRegistry(duty.sourceUrl, expectedSourceUrl)) errors.push(`duty[${index}]: source URL is not the allowlisted source host`);
    if (duty.sourceType !== expectedSourceType) errors.push(`duty[${index}]: source type does not match the registry`);
    if (!isoTimestamp(duty.fetchedAt)) errors.push(`duty[${index}]: fetchedAt is invalid`);
    const endsAt = Date.parse(duty.endsAt);
    const fetchedAt = Date.parse(duty.fetchedAt);
    if (duty.status === 'expired' && endsAt > fetchedAt) errors.push(`duty[${index}]: expired row ends after its fetch timestamp`);
    if (duty.status === 'verified' && endsAt <= fetchedAt) errors.push(`duty[${index}]: verified row is already expired at fetch time`);
  });
  return errors;
}

function genericSnapshotEvaluation(
  snapshot: unknown,
  canton: SwissCanton,
  source: PharmacySourcesRegistry['sources'][string] | null,
  now: Date,
  weekStartKey: string,
  maxAgeMs: number,
): { coverage: SwissCantonOperationalCoverage | null; reason: string } {
  const value = recordOf(snapshot) as unknown as SwissCantonDutySnapshot;
  const weekEndKey = weekEnd(weekStartKey);
  const fetchedAt = isoTimestamp(value._fetchedAt);
  const release = recordOf(value._release);
  const releaseState = nonEmptyString(release.state);
  const releaseSource = recordOf(release.source);
  const releaseScope = recordOf(release.scope);
  const releaseCoverage = recordOf(release.coverage);
  const expectedSourceType = dutySourceTypeFor(source);
  const structuralErrors = [
    value._schemaVersion !== SWISS_CANTON_DUTY_SCHEMA_VERSION ? 'unsupported schema version' : '',
    value._scope?.country !== 'CH' || value._scope?.canton !== canton.code ? 'scope does not match canton' : '',
    !['canton', 'region'].includes(value._scope?.coverageType) ? 'coverage type is invalid' : '',
    value._timezone !== SWISS_CANTON_DUTY_TIMEZONE ? 'timezone is not Europe/Zurich' : '',
    !safeHttpsUrl(value._source) ? 'source URL is not HTTPS' : '',
    !Array.isArray(value.pharmacies) ? 'pharmacy identities are missing' : '',
    !Array.isArray(value.duties) ? 'duty rows are missing' : '',
    value._releaseReady !== true ? 'snapshot is not release-ready' : '',
    releaseState !== 'fresh' ? `release state is ${releaseState || 'unknown'}` : '',
    value._state !== 'fresh' ? `snapshot state is ${value._state || 'unknown'}` : '',
    value._coverage?.coverage !== 'covered' ? 'calendar coverage is not complete' : '',
    !nonEmptyString(release.releaseId) ? 'release id is missing' : '',
    value._sourceKey !== canton.key ? 'source key does not match canton registry' : '',
    source?.officialSourceUrl !== value._source ? 'snapshot source does not match the registry' : '',
    releaseSource.key !== canton.key || releaseSource.url !== value._source ? 'release source does not match the snapshot' : '',
    releaseScope.country !== 'CH' || releaseScope.canton !== canton.code ? 'release scope does not match canton' : '',
    releaseCoverage.coverage !== value._coverage?.coverage ? 'release coverage does not match snapshot' : '',
    releaseState !== value._state ? 'release state does not match snapshot' : '',
    !expectedSourceType ? 'registry source type cannot publish duty rows' : '',
    Array.isArray(value._errors) && value._errors.length > 0 ? 'snapshot reports source errors' : '',
    Array.isArray(value._unresolvedIdentities) && value._unresolvedIdentities.length > 0 ? 'snapshot has unresolved identities' : '',
  ].filter(Boolean);
  if (structuralErrors.length > 0) return { coverage: null, reason: `${canton.code}: ${structuralErrors.join(', ')}` };
  if (!sourceIsActive(source)) return { coverage: null, reason: `${canton.code}: registry source is not active` };
  const freshness = freshnessFor(fetchedAt, now, maxAgeMs);
  if (freshness !== 'fresh') return { coverage: null, reason: `${canton.code}: snapshot freshness is ${freshness}` };
  if (!weekEndKey) return { coverage: null, reason: `${canton.code}: weekStart is invalid` };
  const rowErrors = validDutyRows(value, value._source, expectedSourceType || 'official');
  if (rowErrors.length > 0) return { coverage: null, reason: `${canton.code}: ${rowErrors[0]}` };
  const duties = value.duties
    .filter((duty) => duty.status === 'verified' && intersectsWeek(duty.startsAt, duty.endsAt, weekStartKey, weekEndKey))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  if (duties.length === 0) return { coverage: null, reason: `${canton.code}: no verified duty intersects the selected week` };
  return {
    coverage: {
      code: canton.code,
      key: canton.key,
      name: canton.names.it,
      coverageType: value._scope.coverageType,
      coverageName: value.coverageName,
      sourceUrl: safeHttpsUrl(value._source) || source?.officialSourceUrl || '',
      sourceType: expectedSourceType || 'official',
      fetchedAt: fetchedAt || '',
      releaseId: nonEmptyString(release.releaseId) || '',
      duties,
    },
    reason: '',
  };
}

function genevaCoverage({ canton, source, now, weekStartKey, maxAgeMs }: {
  canton: SwissCanton;
  source: PharmacySourcesRegistry['sources'][string] | null;
  now: Date;
  weekStartKey: string;
  maxAgeMs: number;
}): { coverage: SwissCantonOperationalCoverage | null; reason: string } {
  if (!sourceIsActive(source)) return { coverage: null, reason: 'GE: registry source is not active' };
  const evaluation = evaluateGenevaDutyRelease({
    duties: DEFAULT_GENEVA_DUTIES,
    status: DEFAULT_GENEVA_STATUS,
    now,
    maxAgeMs,
    catalogue: DEFAULT_GENEVA_CATALOGUE,
    sources: DEFAULT_GENEVA_SOURCES,
  });
  if (!evaluation.publishable) return { coverage: null, reason: `GE: ${evaluation.reasons[0] || 'Geneva release is not publishable'}` };
  const weekEndKey = weekEnd(weekStartKey);
  if (!weekEndKey) return { coverage: null, reason: 'GE: weekStart is invalid' };
  const identities = new Map(DEFAULT_GENEVA_CATALOGUE
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .map((entry) => [String(entry.id), entry]));
  const duties = (recordOf(DEFAULT_GENEVA_DUTIES).duties as unknown[])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .filter((entry) => entry.status === 'verified' && intersectsWeek(String(entry.startsAt), String(entry.endsAt), weekStartKey, weekEndKey))
    .map((entry) => {
      const pharmacy = identities.get(String(entry.pharmacyId));
      return {
        id: String(entry.id),
        pharmacyId: String(entry.pharmacyId),
        pharmacyName: String(pharmacy?.name || entry.pharmacyId),
        coverageType: 'canton' as const,
        coverageName: 'Genève',
        startsAt: String(entry.startsAt),
        endsAt: String(entry.endsAt),
        dutyType: String(entry.dutyType) as SwissCantonDuty['dutyType'],
        status: 'verified' as const,
        sourceUrl: String(entry.sourceUrl),
        sourceType: 'association' as const,
        fetchedAt: String(entry.fetchedAt),
        verifiedAt: typeof entry.verifiedAt === 'string' ? entry.verifiedAt : undefined,
      } satisfies SwissCantonDuty;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  if (duties.length === 0) return { coverage: null, reason: 'GE: no verified duty intersects the selected week' };
  return {
    coverage: {
      code: canton.code,
      key: canton.key,
      name: canton.names.it,
      coverageType: 'canton',
      coverageName: 'Genève',
      sourceUrl: GENEVA_SOURCE_URL,
      sourceType: 'association',
      fetchedAt: evaluation.fetchedAt || '',
      releaseId: evaluation.releaseId || '',
      duties,
    },
    reason: '',
  };
}

const GENEVA_SOURCE_URL = 'https://pharmageneve.swiss/pharmacie-de-garde/';

export function buildSwissCantonDutyCoverage(options: BuildSwissCantonDutyCoverageOptions): SwissCantonDutyCoverageResult {
  const maxAgeMs = options.maxAgeMs ?? SWISS_CANTON_DUTY_MAX_AGE_MS;
  const snapshots = options.snapshots || DEFAULT_SNAPSHOTS;
  const operational: SwissCantonOperationalCoverage[] = [];
  const diagnostics: string[] = [];
  const geneva = cantonForCode('GE');
  if (options.includeGeneva !== false && geneva) {
    const result = genevaCoverage({ canton: geneva, source: sourceForRegistry(options.registry, geneva), now: options.now, weekStartKey: options.weekStart, maxAgeMs });
    if (result.coverage) operational.push(result.coverage);
    else diagnostics.push(result.reason);
  }
  for (const [code, snapshot] of Object.entries(snapshots)) {
    if (code === 'GE') continue;
    const canton = cantonForCode(code);
    if (!canton) {
      diagnostics.push(`${code}: snapshot is not a known Swiss canton`);
      continue;
    }
    const result = genericSnapshotEvaluation(snapshot, canton, sourceForRegistry(options.registry, canton), options.now, options.weekStart, maxAgeMs);
    if (result.coverage) operational.push(result.coverage);
    else diagnostics.push(result.reason);
  }
  return Object.freeze({
    operationalCantons: Object.freeze(operational.sort((a, b) => a.code.localeCompare(b.code))),
    diagnostics: Object.freeze(diagnostics.filter(Boolean)),
  });
}
