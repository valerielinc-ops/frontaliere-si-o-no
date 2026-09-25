import { canonicalJson, digestDocument } from './canonical-json-digest.mjs';
import {
  createTranslationUnitIdentity,
  normalizeTranslationText,
} from './translation-unit-identity.mjs';

export const TRANSLATION_UNIT_IDENTITY_V2_SCHEMA_VERSION = 2;
export const TRANSLATION_SHARD_PREFIX_LENGTH = 2;

const CREATE_KEYS = ['context', 'fieldPath', 'kind', 'sourceLocale', 'sourceText', 'targetLocale'];
const CONTEXT_KEYS = ['company', 'location'];
const IDENTITY_KEYS = [
  'contextHash',
  'fieldPath',
  'identityHash',
  'key',
  'kind',
  'schemaVersion',
  'sourceHash',
  'sourceLocale',
  'targetLocale',
];
const ATTEMPT_KEYS = ['engineVersion', 'gateVersion', 'identity'];
export const TRANSLATION_SHA256_PATTERN_V2 = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const TRANSLATION_VERSION_PATTERN_V2 = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;

export function assertTranslationPlainObjectV2(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

export function assertTranslationExactKeysV2(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
}

function normalizeContextValue(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new TypeError(`${label} must be null or bounded text`);
  }
  const normalized = normalizeTranslationText(value);
  if (normalized.trim().length === 0) {
    throw new TypeError(`${label} must contain non-whitespace content`);
  }
  return normalized;
}

function normalizeContext(context) {
  assertTranslationPlainObjectV2(context, 'translation context');
  assertTranslationExactKeysV2(context, CONTEXT_KEYS, 'translation context');
  return Object.freeze({
    company: normalizeContextValue(context.company, 'translation context company'),
    location: normalizeContextValue(context.location, 'translation context location'),
  });
}

export function normalizeTranslationVersionV2(value, label) {
  if (typeof value !== 'string' || !TRANSLATION_VERSION_PATTERN_V2.test(value)) {
    throw new TypeError(`${label} must be a canonical bounded version`);
  }
  return value;
}

export function canonicalTranslationJsonV2(value) {
  return canonicalJson(value);
}

export function digestTranslationDocumentV2(value) {
  return digestDocument(value).slice('sha256:'.length);
}

export function deepFreezeTranslationV2(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeTranslationV2(child);
    Object.freeze(value);
  }
  return value;
}

export function createTranslationUnitIdentityV2(input) {
  assertTranslationPlainObjectV2(input, 'translation identity v2 input');
  assertTranslationExactKeysV2(input, CREATE_KEYS, 'translation identity v2 input');
  if (typeof input.kind !== 'string' || !TOKEN_PATTERN.test(input.kind)) {
    throw new TypeError('translation identity kind must be a canonical token');
  }
  const base = createTranslationUnitIdentity({
    fieldPath: input.fieldPath,
    sourceLocale: input.sourceLocale,
    sourceText: input.sourceText,
    targetLocale: input.targetLocale,
  });
  const context = normalizeContext(input.context);
  const contextHash = digestTranslationDocumentV2(context);
  const identityHash = digestTranslationDocumentV2({
    contextHash,
    fieldPath: base.fieldPath,
    kind: input.kind,
    schemaVersion: TRANSLATION_UNIT_IDENTITY_V2_SCHEMA_VERSION,
    sourceHash: base.sourceHash,
    sourceLocale: base.sourceLocale,
    targetLocale: base.targetLocale,
  });
  return Object.freeze({
    schemaVersion: TRANSLATION_UNIT_IDENTITY_V2_SCHEMA_VERSION,
    kind: input.kind,
    fieldPath: base.fieldPath,
    sourceLocale: base.sourceLocale,
    targetLocale: base.targetLocale,
    sourceHash: base.sourceHash,
    contextHash,
    identityHash,
    key: `translation-unit:v2:${identityHash}`,
  });
}

export function validateTranslationUnitIdentityV2(identity) {
  assertTranslationPlainObjectV2(identity, 'stored translation identity v2');
  assertTranslationExactKeysV2(identity, IDENTITY_KEYS, 'stored translation identity v2');
  if (identity.schemaVersion !== TRANSLATION_UNIT_IDENTITY_V2_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation identity v2 schemaVersion');
  }
  if (typeof identity.kind !== 'string' || !TOKEN_PATTERN.test(identity.kind)) {
    throw new TypeError('stored translation identity v2 kind is invalid');
  }
  for (const [label, hash] of [
    ['sourceHash', identity.sourceHash],
    ['contextHash', identity.contextHash],
    ['identityHash', identity.identityHash],
  ]) {
    if (typeof hash !== 'string' || !TRANSLATION_SHA256_PATTERN_V2.test(hash)) {
      throw new TypeError(`stored translation identity v2 ${label} is invalid`);
    }
  }
  const expectedHash = digestTranslationDocumentV2({
    contextHash: identity.contextHash,
    fieldPath: identity.fieldPath,
    kind: identity.kind,
    schemaVersion: identity.schemaVersion,
    sourceHash: identity.sourceHash,
    sourceLocale: identity.sourceLocale,
    targetLocale: identity.targetLocale,
  });
  if (identity.identityHash !== expectedHash || identity.key !== `translation-unit:v2:${expectedHash}`) {
    throw new TypeError('stored translation identity v2 key does not match its content');
  }
  const checkedBase = createTranslationUnitIdentity({
    fieldPath: identity.fieldPath,
    sourceLocale: identity.sourceLocale,
    sourceText: identity.sourceHash,
    targetLocale: identity.targetLocale,
  });
  if (
    checkedBase.fieldPath !== identity.fieldPath
    || checkedBase.sourceLocale !== identity.sourceLocale
    || checkedBase.targetLocale !== identity.targetLocale
  ) {
    throw new TypeError('stored translation identity v2 fields are not canonical');
  }
  return Object.freeze({ ...identity });
}

export function createTranslationAttemptKeyV2(input) {
  assertTranslationPlainObjectV2(input, 'translation attempt v2 input');
  assertTranslationExactKeysV2(input, ATTEMPT_KEYS, 'translation attempt v2 input');
  const identity = validateTranslationUnitIdentityV2(input.identity);
  const engineVersion = normalizeTranslationVersionV2(input.engineVersion, 'engineVersion');
  const gateVersion = normalizeTranslationVersionV2(input.gateVersion, 'gateVersion');
  const digest = digestTranslationDocumentV2({
    engineVersion,
    gateVersion,
    identityKey: identity.key,
    schemaVersion: TRANSLATION_UNIT_IDENTITY_V2_SCHEMA_VERSION,
  });
  return `translation-attempt:v2:${digest}`;
}

export function translationShardForIdentityV2(identity) {
  const validated = validateTranslationUnitIdentityV2(identity);
  return `v2/${validated.identityHash.slice(0, TRANSLATION_SHARD_PREFIX_LENGTH)}`;
}
