const PHARMACY_RELEASE_CONTRACT_VERSION = 1;
const PHARMACY_RELEASE_TIMEZONE = 'Europe/Zurich';
const PHARMACY_RELEASE_REGION_KEYS = [
  'mendrisiotto',
  'luganese',
  'bellinzonese',
  'biasca-e-valli',
];
const RELEASE_STATES = [
  'unknown',
  'fresh',
  'stale',
  'partial',
  'conflicting',
  'expired',
  'not_published',
];
const RELEASE_FRESHNESS_STATES = ['fresh', 'stale', 'unknown'];
const RELEASE_COVERAGE_STATES = ['covered', 'partial', 'not_published', 'unknown'];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateReleaseTimestamp(label, value, errors) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
    errors.push(`${label}: expected an ISO timestamp or null`);
  }
}

function validateReleaseSnapshot(label, snapshot, errors) {
  if (!isObject(snapshot)) {
    errors.push(`${label}: expected an object`);
    return;
  }
  if (typeof snapshot.path !== 'string' || snapshot.path.trim() === '') {
    errors.push(`${label}: missing or empty "path"`);
  }
  if (typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
    errors.push(`${label}: invalid "sha256"`);
  }
  validateReleaseTimestamp(`${label}.fetchedAt`, snapshot.fetchedAt, errors);
}

/** Validates the atomic catalogue+duties release metadata. */
export function validatePharmacyReleaseContract(contract) {
  if (!isObject(contract)) return ['release: expected an object'];
  const errors = [];

  if (contract.version !== PHARMACY_RELEASE_CONTRACT_VERSION) {
    errors.push(`release: unsupported version "${String(contract.version)}"`);
  }
  if (typeof contract.releaseId !== 'string' || !/^pharmacy-v1-[a-f0-9]{64}$/.test(contract.releaseId)) {
    errors.push('release: invalid "releaseId"');
  }
  if (contract.timezone !== PHARMACY_RELEASE_TIMEZONE) {
    errors.push(`release: timezone must be "${PHARMACY_RELEASE_TIMEZONE}"`);
  }
  if (typeof contract.state !== 'string' || !RELEASE_STATES.includes(contract.state)) {
    errors.push(`release: invalid state "${String(contract.state)}"`);
  }

  if (!isObject(contract.scope)) {
    errors.push('release: missing "scope" object');
  } else {
    if (contract.scope.country !== 'CH') errors.push('release.scope: country must be "CH"');
    if (contract.scope.canton !== 'Ticino') errors.push('release.scope: canton must be "Ticino"');
    if (!Array.isArray(contract.scope.regions)) {
      errors.push('release.scope: regions must be an array');
    } else {
      const regions = contract.scope.regions;
      const expected = [...PHARMACY_RELEASE_REGION_KEYS];
      const valid = regions.every((region) => typeof region === 'string' && expected.includes(region));
      if (!valid || regions.length !== expected.length || new Set(regions).size !== expected.length) {
        errors.push(`release.scope: regions must be exactly ${expected.join(', ')}`);
      }
    }
  }

  if (!isObject(contract.snapshots)) {
    errors.push('release: missing "snapshots" object');
  } else {
    validateReleaseSnapshot('release.snapshots.catalogue', contract.snapshots.catalogue, errors);
    validateReleaseSnapshot('release.snapshots.duties', contract.snapshots.duties, errors);
  }

  if (!isObject(contract.regions)) {
    errors.push('release: missing "regions" object');
  } else {
    const expected = [...PHARMACY_RELEASE_REGION_KEYS].sort();
    const actual = Object.keys(contract.regions).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      errors.push(`release.regions: keys must be exactly ${expected.join(', ')}`);
    }
    for (const key of PHARMACY_RELEASE_REGION_KEYS) {
      const region = contract.regions[key];
      if (!isObject(region)) {
        errors.push(`release.regions.${key}: missing region status`);
        continue;
      }
      if (typeof region.name !== 'string' || region.name.trim() === '') errors.push(`release.regions.${key}: invalid "name"`);
      if (typeof region.sourceUrl !== 'string' || region.sourceUrl.trim() === '') errors.push(`release.regions.${key}: invalid "sourceUrl"`);
      if (!Number.isInteger(region.dutyCount) || region.dutyCount < 0) errors.push(`release.regions.${key}: invalid "dutyCount"`);
      validateReleaseTimestamp(`release.regions.${key}.fetchedAt`, region.fetchedAt, errors);
      if (typeof region.freshness !== 'string' || !RELEASE_FRESHNESS_STATES.includes(region.freshness)) {
        errors.push(`release.regions.${key}: invalid "freshness"`);
      }
      if (typeof region.coverage !== 'string' || !RELEASE_COVERAGE_STATES.includes(region.coverage)) {
        errors.push(`release.regions.${key}: invalid "coverage"`);
      }
      if (typeof region.state !== 'string' || !RELEASE_STATES.includes(region.state)) {
        errors.push(`release.regions.${key}: invalid "state"`);
      }
      if (typeof region.preserved !== 'boolean') errors.push(`release.regions.${key}: invalid "preserved"`);
    }
  }

  return errors;
}
