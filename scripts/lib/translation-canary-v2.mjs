import { createHash } from 'node:crypto';

export const TRANSLATION_CANARY_V2_DEFAULT_SCOPE = 'translation-shadow-v2';
export const TRANSLATION_CANARY_V2_DEFAULT_EXPOSURE_PERCENT = 0;
export const TRANSLATION_CANARY_V2_DEFAULT_MAX_UNITS = 25;
export const TRANSLATION_CANARY_V2_MAX_EXPOSURE_PERCENT = 100;
export const TRANSLATION_CANARY_V2_MAX_UNITS = 250;

const MAX_PERCENT_DECIMAL_PLACES = 4;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
const MAX_IDENTITY_KEY_LENGTH = 512;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeScopeKey(value) {
  if (typeof value !== 'string' || !SCOPE_PATTERN.test(value)) {
    throw new TypeError('translation canary scopeKey is invalid');
  }
  return value;
}

function normalizeIdentityKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_KEY_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('translation canary identityKey is invalid');
  }
  return value;
}

function normalizeExposurePercent(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') throw new TypeError('translation canary exposurePercent is invalid');
  const text = typeof value === 'number' ? String(value) : value.trim();
  const decimalPattern = new RegExp(`^(?:0|[1-9]\\d{0,2})(?:\\.\\d{1,${MAX_PERCENT_DECIMAL_PLACES}})?$`, 'u');
  if (!decimalPattern.test(text)) {
    throw new TypeError('translation canary exposurePercent is invalid');
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > TRANSLATION_CANARY_V2_MAX_EXPOSURE_PERCENT) {
    throw new TypeError('translation canary exposurePercent is invalid');
  }
  return Math.round(parsed * (10 ** MAX_PERCENT_DECIMAL_PLACES));
}

function normalizeMaxUnits(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') throw new TypeError('translation canary maxUnits is invalid');
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > TRANSLATION_CANARY_V2_MAX_UNITS) {
    throw new TypeError('translation canary maxUnits is invalid');
  }
  return parsed;
}

export function normalizeTranslationCanaryConfigV2(input = {}) {
  assertPlainObject(input, 'translation canary config');
  const exposureBasisPoints = normalizeExposurePercent(
    input.exposurePercent,
    TRANSLATION_CANARY_V2_DEFAULT_EXPOSURE_PERCENT * (10 ** MAX_PERCENT_DECIMAL_PLACES),
  );
  return Object.freeze({
    scopeKey: normalizeScopeKey(input.scopeKey ?? TRANSLATION_CANARY_V2_DEFAULT_SCOPE),
    exposurePercent: exposureBasisPoints / (10 ** MAX_PERCENT_DECIMAL_PLACES),
    maxUnits: normalizeMaxUnits(input.maxUnits, TRANSLATION_CANARY_V2_DEFAULT_MAX_UNITS),
  });
}

function identityBucket(scopeKey, identityKey) {
  const digest = createHash('sha256')
    .update(`${scopeKey}\u0000${identityKey}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function evaluateTranslationCanaryIdentityV2({
  scopeKey = TRANSLATION_CANARY_V2_DEFAULT_SCOPE,
  identityKey,
  exposurePercent = TRANSLATION_CANARY_V2_DEFAULT_EXPOSURE_PERCENT,
} = {}) {
  const config = normalizeTranslationCanaryConfigV2({ scopeKey, exposurePercent });
  const normalizedIdentityKey = normalizeIdentityKey(identityKey);
  const bucket = identityBucket(config.scopeKey, normalizedIdentityKey);
  return Object.freeze({
    bucket,
    eligible: bucket < config.exposurePercent / TRANSLATION_CANARY_V2_MAX_EXPOSURE_PERCENT,
    exposurePercent: config.exposurePercent,
    identityKey: normalizedIdentityKey,
    scopeKey: config.scopeKey,
  });
}

/**
 * Select a stable, bounded cohort from the planned generation identities.
 * The hash includes the scope so separate scheduler lanes cannot silently share
 * a cohort, while the identity key keeps the assignment stable across scans.
 */
export function selectTranslationCanaryUnitsV2({
  scopeKey = TRANSLATION_CANARY_V2_DEFAULT_SCOPE,
  exposurePercent = TRANSLATION_CANARY_V2_DEFAULT_EXPOSURE_PERCENT,
  maxUnits = TRANSLATION_CANARY_V2_DEFAULT_MAX_UNITS,
  identityKeys,
} = {}) {
  const config = normalizeTranslationCanaryConfigV2({ scopeKey, exposurePercent, maxUnits });
  if (!Array.isArray(identityKeys)) {
    throw new TypeError('translation canary identityKeys must be an array');
  }
  const normalizedIdentityKeys = identityKeys.map(normalizeIdentityKey);
  const uniqueIdentityKeys = [...new Set(normalizedIdentityKeys)].sort();
  const decisions = uniqueIdentityKeys
    .map((identityKey) => {
      const bucket = identityBucket(config.scopeKey, identityKey);
      return { bucket, eligible: bucket < config.exposurePercent / 100, identityKey };
    })
    .sort((left, right) => left.bucket - right.bucket
      || (left.identityKey < right.identityKey ? -1 : left.identityKey > right.identityKey ? 1 : 0));
  const eligibleIdentityKeys = decisions.filter((decision) => decision.eligible)
    .map((decision) => decision.identityKey);
  const selectedIdentityKeys = eligibleIdentityKeys.slice(0, config.maxUnits);
  const selected = new Set(selectedIdentityKeys);
  const eligibleSet = new Set(eligibleIdentityKeys);
  const selectedUnits = normalizedIdentityKeys.filter((identityKey) => selected.has(identityKey)).length;
  const eligibleUnits = normalizedIdentityKeys.filter((identityKey) => eligibleSet.has(identityKey)).length;

  return Object.freeze({
    ...config,
    decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
    eligibleIdentityKeys: Object.freeze(eligibleIdentityKeys),
    eligibleUnits,
    populationUnits: normalizedIdentityKeys.length,
    selectedIdentityKeys: Object.freeze(selectedIdentityKeys),
    selectedUnits,
    skippedUnits: normalizedIdentityKeys.length - selectedUnits,
    uniqueIdentityCount: uniqueIdentityKeys.length,
  });
}
