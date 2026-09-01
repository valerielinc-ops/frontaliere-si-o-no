import { resolveJobDiffKey } from './job-match-key.mjs';
import {
  TRANSLATION_MEMORY_V2_SCHEMA_VERSION,
  validateTranslationMemoryV2,
} from './content-addressed-translation-memory-v2.mjs';
import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  canonicalTranslationJsonV2,
  createTranslationUnitIdentityV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
  TRANSLATION_SHA256_PATTERN_V2,
  validateTranslationUnitIdentityV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText } from './translation-unit-identity.mjs';

export const TRANSLATION_DERIVED_PATCH_V2_SCHEMA_VERSION = 2;

const CREATE_KEYS = ['candidate', 'crawlerKey', 'fieldPath', 'job', 'targetLocale'];
const PATCH_KEYS = ['candidate', 'destination', 'identity', 'patchHash', 'schemaVersion', 'target'];
const TARGET_KEYS = ['crawlerKey', 'jobKey', 'url'];
const DESTINATION_KEYS = ['fieldPath', 'localeFieldPath', 'targetLocale'];
const IDENTITY_OPTIONS_KEYS = ['fieldPath', 'targetLocale'];
const ALLOWED_FIELDS = new Set(['description', 'title']);
const CRAWLER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function canonicalContextValue(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new TypeError(`${label} must be null or bounded text`);
  }
  const normalized = normalizeTranslationText(value).trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}

function assertCanonicalTargetText(value, label, maxLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || normalizeTranslationText(value) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be canonical bounded text`);
  }
  return value;
}

function validateFieldPath(fieldPath) {
  if (!ALLOWED_FIELDS.has(fieldPath)) {
    throw new TypeError('translation derived patch fieldPath must be title or description');
  }
  return fieldPath;
}

function own(job, key) {
  return Object.hasOwn(job, key) ? job[key] : undefined;
}

function validateCandidateForIdentity(candidate, identity) {
  const memory = validateTranslationMemoryV2({
    schemaVersion: TRANSLATION_MEMORY_V2_SCHEMA_VERSION,
    records: [{ identity, candidates: [candidate] }],
  });
  return memory.records[0].candidates[0];
}

function patchPayload({ candidate, destination, identity, target }) {
  return {
    candidate,
    destination,
    identity,
    schemaVersion: TRANSLATION_DERIVED_PATCH_V2_SCHEMA_VERSION,
    target,
  };
}

export function canonicalJobTranslationContextV2(job) {
  assertTranslationPlainObjectV2(job, 'translation derived patch job');
  return Object.freeze({
    company: canonicalContextValue(own(job, 'company'), 'job company'),
    location: canonicalContextValue(own(job, 'location'), 'job location'),
  });
}

export function resolveJobTranslationTargetKeyV2(job) {
  assertTranslationPlainObjectV2(job, 'translation derived patch job');
  return resolveJobDiffKey({
    id: own(job, 'id'),
    slug: own(job, 'slug'),
    url: own(job, 'url'),
  });
}

export function createJobTranslationUnitIdentityV2(job, options) {
  assertTranslationPlainObjectV2(job, 'translation derived patch job');
  assertTranslationPlainObjectV2(options, 'translation identity v2 job options');
  assertTranslationExactKeysV2(
    options,
    IDENTITY_OPTIONS_KEYS,
    'translation identity v2 job options',
  );
  const checkedFieldPath = validateFieldPath(options.fieldPath);
  return createTranslationUnitIdentityV2({
    kind: 'job',
    fieldPath: checkedFieldPath,
    sourceLocale: own(job, 'sourceLang'),
    targetLocale: options.targetLocale,
    sourceText: own(job, checkedFieldPath),
    context: canonicalJobTranslationContextV2(job),
  });
}

export function createTranslationDerivedPatchV2(input) {
  assertTranslationPlainObjectV2(input, 'translation derived patch v2 input');
  assertTranslationExactKeysV2(input, CREATE_KEYS, 'translation derived patch v2 input');
  if (typeof input.crawlerKey !== 'string' || !CRAWLER_KEY_PATTERN.test(input.crawlerKey)) {
    throw new TypeError('translation derived patch crawlerKey is invalid');
  }
  const fieldPath = validateFieldPath(input.fieldPath);
  const identity = createJobTranslationUnitIdentityV2(input.job, {
    fieldPath,
    targetLocale: input.targetLocale,
  });
  const jobKey = resolveJobTranslationTargetKeyV2(input.job);
  if (typeof jobKey !== 'string') {
    throw new TypeError('translation derived patch job has no stable key');
  }
  const target = Object.freeze({
    crawlerKey: input.crawlerKey,
    jobKey: assertCanonicalTargetText(jobKey, 'translation derived patch jobKey', 4096),
    url: assertCanonicalTargetText(own(input.job, 'url'), 'translation derived patch url', 4096),
  });
  const destination = Object.freeze({
    fieldPath,
    localeFieldPath: `${fieldPath}ByLocale.${identity.targetLocale}`,
    targetLocale: identity.targetLocale,
  });
  const candidate = validateCandidateForIdentity(input.candidate, identity);
  const payload = patchPayload({ candidate, destination, identity, target });
  return deepFreezeTranslationV2({
    ...payload,
    patchHash: digestTranslationDocumentV2(payload),
  });
}

export function validateTranslationDerivedPatchV2(patch) {
  assertTranslationPlainObjectV2(patch, 'translation derived patch v2');
  assertTranslationExactKeysV2(patch, PATCH_KEYS, 'translation derived patch v2');
  if (patch.schemaVersion !== TRANSLATION_DERIVED_PATCH_V2_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation derived patch schemaVersion');
  }
  assertTranslationPlainObjectV2(patch.target, 'translation derived patch target');
  assertTranslationExactKeysV2(patch.target, TARGET_KEYS, 'translation derived patch target');
  if (typeof patch.target.crawlerKey !== 'string' || !CRAWLER_KEY_PATTERN.test(patch.target.crawlerKey)) {
    throw new TypeError('translation derived patch crawlerKey is invalid');
  }
  const target = Object.freeze({
    crawlerKey: patch.target.crawlerKey,
    jobKey: assertCanonicalTargetText(patch.target.jobKey, 'translation derived patch jobKey', 4096),
    url: assertCanonicalTargetText(patch.target.url, 'translation derived patch url', 4096),
  });
  assertTranslationPlainObjectV2(patch.destination, 'translation derived patch destination');
  assertTranslationExactKeysV2(
    patch.destination,
    DESTINATION_KEYS,
    'translation derived patch destination',
  );
  const fieldPath = validateFieldPath(patch.destination.fieldPath);
  const identity = validateTranslationUnitIdentityV2(patch.identity);
  if (
    identity.kind !== 'job'
    || identity.fieldPath !== fieldPath
    || patch.destination.targetLocale !== identity.targetLocale
    || patch.destination.localeFieldPath !== `${fieldPath}ByLocale.${identity.targetLocale}`
  ) {
    throw new TypeError('translation derived patch destination does not match its identity');
  }
  const destination = Object.freeze({
    fieldPath,
    localeFieldPath: patch.destination.localeFieldPath,
    targetLocale: identity.targetLocale,
  });
  const candidate = validateCandidateForIdentity(patch.candidate, identity);
  const payload = patchPayload({ candidate, destination, identity, target });
  const expectedHash = digestTranslationDocumentV2(payload);
  if (
    typeof patch.patchHash !== 'string'
    || !TRANSLATION_SHA256_PATTERN_V2.test(patch.patchHash)
    || patch.patchHash !== expectedHash
  ) {
    throw new TypeError('translation derived patch hash does not match its content');
  }
  return deepFreezeTranslationV2({ ...payload, patchHash: expectedHash });
}

export function serializeTranslationDerivedPatchV2(patch) {
  return `${canonicalTranslationJsonV2(validateTranslationDerivedPatchV2(patch))}\n`;
}
