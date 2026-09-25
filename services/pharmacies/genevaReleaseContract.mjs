import { sha256 } from '@noble/hashes/sha256';

export const GENEVA_DUTY_RELEASE_VERSION = 1;
export const GENEVA_DUTY_RELEASE_TIMEZONE = 'Europe/Zurich';
export const GENEVA_DUTY_RELEASE_CANTON = 'GE';
export const GENEVA_DUTY_RELEASE_SOURCE_KEY = 'pharmageneve-garde-2026';
export const GENEVA_DUTY_RELEASE_SOURCE_URL = 'https://pharmageneve.swiss/pharmacie-de-garde/';
export const GENEVA_DUTY_RELEASE_COVERAGE_NAME = 'Genève';
export const GENEVA_DUTY_RELEASE_VALID_FROM = '2026-01-01';
export const GENEVA_DUTY_RELEASE_VALID_TO = '2026-12-31';
export const GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS = 365;
export const GENEVA_DUTY_RELEASE_PREFIX = 'pharmacy-geneva-v1-';
export const GENEVA_DUTY_RELEASE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const RELEASE_STATES = Object.freeze([
  'unknown',
  'fresh',
  'stale',
  'partial',
  'conflicting',
  'not_published',
]);
const SOURCE_STATUSES = Object.freeze(['unverified', 'active', 'degraded', 'blocked']);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function httpsUrl(value) {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname ? candidate : null;
  } catch {
    return null;
  }
}

export function validateGenevaDutySourceRegistry(registry) {
  const errors = [];
  if (!isRecord(registry)) return ['source registry: expected an object'];
  if (registry.version !== GENEVA_DUTY_RELEASE_VERSION) errors.push('source registry: unsupported version');
  if (!isIsoTimestamp(registry.generatedAt)) errors.push('source registry: generatedAt must be an ISO timestamp');
  if (registry.timezone !== GENEVA_DUTY_RELEASE_TIMEZONE) {
    errors.push(`source registry: timezone must be ${GENEVA_DUTY_RELEASE_TIMEZONE}`);
  }
  if (!isRecord(registry.scope)
    || registry.scope.country !== 'CH'
    || registry.scope.canton !== GENEVA_DUTY_RELEASE_CANTON) {
    errors.push('source registry: scope must be CH/GE');
  }

  const coverage = registry.coverage;
  if (!isRecord(coverage)
    || coverage.validFrom !== GENEVA_DUTY_RELEASE_VALID_FROM
    || coverage.validTo !== GENEVA_DUTY_RELEASE_VALID_TO
    || coverage.minimumCalendarDays !== GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS
    || coverage.requireContiguous !== true) {
    errors.push('source registry: coverage must require the complete contiguous 2026 calendar');
  }
  if (isRecord(coverage)) {
    if (!isCalendarDate(coverage.validFrom) || !isCalendarDate(coverage.validTo)) {
      errors.push('source registry: coverage dates must be valid calendar dates');
    }
    if (coverage.validFrom > coverage.validTo) errors.push('source registry: coverage window is inverted');
  }

  if (!Array.isArray(registry.sources) || registry.sources.length !== 1) {
    errors.push('source registry: exactly one official source is required');
    return errors;
  }

  const source = registry.sources[0];
  if (!isRecord(source)) return [...errors, 'source[0]: expected an object'];
  if (source.key !== GENEVA_DUTY_RELEASE_SOURCE_KEY) errors.push('source[0]: source key is invalid');
  if (!stringValue(source.name)) errors.push('source[0]: name is missing');
  if (source.sourceType !== 'association') errors.push('source[0]: sourceType must be association');
  if (source.accessMethod !== 'html-scrape') errors.push('source[0]: accessMethod must be html-scrape');
  if (source.fetchFrequency !== 'P1D') errors.push('source[0]: fetchFrequency must be P1D');
  if (!stringValue(source.owner)) errors.push('source[0]: owner is missing');
  if (!SOURCE_STATUSES.includes(source.status)) errors.push('source[0]: status is invalid');
  if (httpsUrl(source.officialSourceUrl) !== GENEVA_DUTY_RELEASE_SOURCE_URL) {
    errors.push('source[0]: officialSourceUrl is not the allowlisted Pharma Genève page');
  }
  if (source.identityMode !== 'catalogue-required') errors.push('source[0]: identityMode must be catalogue-required');
  if (!Array.isArray(source.identityAliases) || source.identityAliases.length === 0) {
    errors.push('source[0]: identityAliases must be a non-empty array');
  } else {
    const labels = new Set();
    const ids = new Set();
    source.identityAliases.forEach((alias, index) => {
      if (!isRecord(alias) || !stringValue(alias.sourceLabel) || !stringValue(alias.pharmacyId)) {
        errors.push(`source[0].identityAliases[${index}]: sourceLabel and pharmacyId are required`);
        return;
      }
      const label = alias.sourceLabel.trim().toLocaleLowerCase('fr-FR');
      const id = alias.pharmacyId.trim();
      if (labels.has(label)) errors.push(`source[0].identityAliases[${index}]: sourceLabel is duplicated`);
      if (ids.has(id)) errors.push(`source[0].identityAliases[${index}]: pharmacyId is duplicated`);
      labels.add(label);
      ids.add(id);
    });
  }
  return errors;
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Geneva release contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodePoint(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new Error(`Geneva release contains unsupported value ${typeof value}`);
}

export function canonicalGenevaDutyJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256GenevaDutyPayload(value) {
  return Array.from(
    sha256(new TextEncoder().encode(canonicalGenevaDutyJson(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function withoutRelease(snapshot) {
  const { _release: _ignoredRelease, ...payload } = isRecord(snapshot) ? snapshot : {};
  return payload;
}

function sourceDescriptor(sources) {
  const source = isRecord(sources) && Array.isArray(sources.sources) && isRecord(sources.sources[0])
    ? sources.sources[0]
    : {};
  return {
    key: stringValue(source.key) || '',
    url: httpsUrl(source.officialSourceUrl) || '',
  };
}

function integerOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function releaseState(duties, status, sources) {
  const sourceErrors = validateGenevaDutySourceRegistry(sources);
  const source = isRecord(sources) && Array.isArray(sources.sources) ? sources.sources[0] : null;
  const statusErrors = isRecord(status) && Array.isArray(status._errors) ? status._errors : null;
  const statusWarnings = isRecord(status) && Array.isArray(status._warnings) ? status._warnings : null;
  const dutyErrors = isRecord(duties) && Array.isArray(duties._errors) ? duties._errors : null;
  const coverage = isRecord(status?._coverage) ? status._coverage : null;
  const dutyRows = isRecord(duties) && Array.isArray(duties.duties) ? duties.duties : null;
  if (sourceErrors.length > 0
    || source?.status !== 'active'
    || statusErrors === null
    || statusWarnings === null
    || dutyErrors === null
    || coverage === null
    || dutyRows === null
    || status?._allSourcesFailed !== false
    || status?._releaseReady !== true
    || duties?._releaseReady !== true
    || status?._state !== 'fresh'
    || duties?._state !== 'fresh'
    || statusErrors.length > 0
    || dutyErrors.length > 0
    || coverage.coverage !== 'covered'
    || coverage.observedCalendarDays !== GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS
    || coverage.uncoveredCalendarDays !== 0
    || dutyRows.length === 0) {
    return 'not_published';
  }
  return 'fresh';
}

export function buildGenevaDutyRelease({ duties, status, sources, evaluatedAt }) {
  if (!isIsoTimestamp(evaluatedAt)) throw new Error('evaluatedAt must be an ISO timestamp');
  const coverage = isRecord(status?._coverage) ? status._coverage : {};
  const source = sourceDescriptor(sources);
  const body = {
    version: GENEVA_DUTY_RELEASE_VERSION,
    timezone: GENEVA_DUTY_RELEASE_TIMEZONE,
    state: releaseState(duties, status, sources),
    evaluatedAt,
    scope: { country: 'CH', canton: GENEVA_DUTY_RELEASE_CANTON },
    source,
    coverage: {
      validFrom: stringValue(coverage.validFrom) || null,
      validTo: stringValue(coverage.validTo) || null,
      minimumCalendarDays: integerOrZero(coverage.minimumCalendarDays),
      observedCalendarDays: integerOrZero(coverage.observedCalendarDays),
      uncoveredCalendarDays: integerOrZero(coverage.uncoveredCalendarDays),
      coverage: stringValue(coverage.coverage) || 'unknown',
    },
    snapshots: {
      duties: {
        path: 'data/pharmacy-duties-geneva.json',
        sha256: sha256GenevaDutyPayload(withoutRelease(duties)),
        fetchedAt: isIsoTimestamp(duties?._fetchedAt) ? duties._fetchedAt : null,
      },
      status: {
        path: 'data/pharmacy-duties-geneva-status.json',
        sha256: sha256GenevaDutyPayload(withoutRelease(status)),
        fetchedAt: isIsoTimestamp(status?._fetchedAt) ? status._fetchedAt : null,
      },
    },
  };
  return {
    ...body,
    releaseId: `${GENEVA_DUTY_RELEASE_PREFIX}${sha256GenevaDutyPayload(body)}`,
  };
}

export function buildAtomicGenevaDutySnapshots({ duties, status, sources, evaluatedAt }) {
  const cleanDuties = withoutRelease(duties);
  const cleanStatus = withoutRelease(status);
  const release = buildGenevaDutyRelease({
    duties: cleanDuties,
    status: cleanStatus,
    sources,
    evaluatedAt,
  });
  return {
    duties: { ...cleanDuties, _release: release },
    status: { ...cleanStatus, _release: release },
    release,
  };
}

function validateSnapshot(label, snapshot, errors) {
  if (!isRecord(snapshot)) {
    errors.push(`${label}: expected an object`);
    return;
  }
  if (typeof snapshot.path !== 'string' || snapshot.path.trim() === '') errors.push(`${label}.path: missing`);
  if (typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) errors.push(`${label}.sha256: invalid`);
  if (snapshot.fetchedAt !== null && !isIsoTimestamp(snapshot.fetchedAt)) errors.push(`${label}.fetchedAt: invalid`);
}

export function validateGenevaDutyRelease(release) {
  const errors = [];
  if (!isRecord(release)) return ['release: expected an object'];
  if (release.version !== GENEVA_DUTY_RELEASE_VERSION) errors.push('release.version: unsupported');
  if (typeof release.releaseId !== 'string' || !new RegExp(`^${GENEVA_DUTY_RELEASE_PREFIX}[a-f0-9]{64}$`).test(release.releaseId)) {
    errors.push('release.releaseId: invalid');
  }
  if (release.timezone !== GENEVA_DUTY_RELEASE_TIMEZONE) errors.push('release.timezone: invalid');
  if (!RELEASE_STATES.includes(release.state)) errors.push('release.state: invalid');
  if (!isIsoTimestamp(release.evaluatedAt)) errors.push('release.evaluatedAt: invalid');
  if (!isRecord(release.scope) || release.scope.country !== 'CH' || release.scope.canton !== GENEVA_DUTY_RELEASE_CANTON) {
    errors.push('release.scope: must be CH/GE');
  }
  if (!isRecord(release.source)
    || release.source.key !== GENEVA_DUTY_RELEASE_SOURCE_KEY
    || release.source.url !== GENEVA_DUTY_RELEASE_SOURCE_URL) {
    errors.push('release.source: must be the allowlisted Pharma Genève source');
  }
  if (!isRecord(release.coverage)
    || release.coverage.validFrom !== GENEVA_DUTY_RELEASE_VALID_FROM
    || release.coverage.validTo !== GENEVA_DUTY_RELEASE_VALID_TO
    || release.coverage.minimumCalendarDays !== GENEVA_DUTY_RELEASE_MINIMUM_CALENDAR_DAYS
    || !['covered', 'partial', 'not_published', 'unknown'].includes(release.coverage.coverage)
    || !Number.isInteger(release.coverage.observedCalendarDays)
    || release.coverage.observedCalendarDays < 0
    || !Number.isInteger(release.coverage.uncoveredCalendarDays)
    || release.coverage.uncoveredCalendarDays < 0) {
    errors.push('release.coverage: invalid 2026 coverage metadata');
  }
  if (!isRecord(release.snapshots)) errors.push('release.snapshots: missing');
  else {
    validateSnapshot('release.snapshots.duties', release.snapshots.duties, errors);
    validateSnapshot('release.snapshots.status', release.snapshots.status, errors);
  }
  return errors;
}

export function verifyGenevaDutyRelease({ duties, status, sources }) {
  const errors = [];
  const dutiesRelease = duties?._release;
  const statusRelease = status?._release;
  errors.push(...validateGenevaDutyRelease(dutiesRelease).map((error) => `duties: ${error}`));
  errors.push(...validateGenevaDutyRelease(statusRelease).map((error) => `status: ${error}`));
  if (!isRecord(dutiesRelease) || !isRecord(statusRelease)) return errors;
  if (dutiesRelease.releaseId !== statusRelease.releaseId) errors.push('releaseId differs between duties and status');

  const expectedDutiesHash = sha256GenevaDutyPayload(withoutRelease(duties));
  const expectedStatusHash = sha256GenevaDutyPayload(withoutRelease(status));
  const dutiesSnapshots = isRecord(dutiesRelease.snapshots) ? dutiesRelease.snapshots : {};
  const statusSnapshots = isRecord(statusRelease.snapshots) ? statusRelease.snapshots : {};
  if (dutiesSnapshots.duties?.sha256 !== expectedDutiesHash || statusSnapshots.duties?.sha256 !== expectedDutiesHash) {
    errors.push('duties payload hash mismatch');
  }
  if (dutiesSnapshots.status?.sha256 !== expectedStatusHash || statusSnapshots.status?.sha256 !== expectedStatusHash) {
    errors.push('status payload hash mismatch');
  }

  const evaluatedAt = typeof dutiesRelease.evaluatedAt === 'string' ? dutiesRelease.evaluatedAt : '';
  if (evaluatedAt) {
    try {
      const expected = buildGenevaDutyRelease({ duties: withoutRelease(duties), status: withoutRelease(status), sources, evaluatedAt });
      const expectedWithoutId = canonicalGenevaDutyJson({ ...expected, releaseId: undefined });
      if (expected.releaseId !== dutiesRelease.releaseId) errors.push('releaseId does not match the release contract');
      if (expectedWithoutId !== canonicalGenevaDutyJson({ ...dutiesRelease, releaseId: undefined })) {
        errors.push('release metadata does not match the payload contract');
      }
      if (expectedWithoutId !== canonicalGenevaDutyJson({ ...statusRelease, releaseId: undefined })) {
        errors.push('status release metadata does not match the payload contract');
      }
    } catch {
      errors.push('release contract could not be rebuilt');
    }
  }
  return [...new Set(errors)];
}
