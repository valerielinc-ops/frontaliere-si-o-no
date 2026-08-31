import { createHash } from 'node:crypto';

export const TRANSLATION_UNIT_IDENTITY_SCHEMA_VERSION = 1;

const CREATE_KEYS = ['fieldPath', 'sourceLocale', 'sourceText', 'targetLocale'];
const STORED_KEYS = ['fieldPath', 'key', 'schemaVersion', 'sourceHash', 'sourceLocale', 'targetLocale'];
const LOCALE_PATTERN = /^(?:it|en|de|fr)(?:-[a-z0-9]{2,8})*$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
}

function normalizeLocale(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || !LOCALE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a valid locale tag`);
  }
  return value.toLowerCase();
}

function validateFieldPath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError('fieldPath must be a non-empty canonical path');
  }
  return value;
}

function keyFromParts({ sourceLocale, targetLocale, fieldPath, sourceHash }) {
  const encodedFieldPath = Buffer.from(fieldPath, 'utf8').toString('base64url');
  return `translation-unit:v${TRANSLATION_UNIT_IDENTITY_SCHEMA_VERSION}:${sourceLocale}:${targetLocale}:${encodedFieldPath}:${sourceHash}`;
}

export function normalizeTranslationText(value) {
  if (typeof value !== 'string') {
    throw new TypeError('translation text must be a string');
  }
  return value.replace(/\r\n/g, '\n').normalize('NFC');
}

export function sha256TranslationText(value) {
  return createHash('sha256').update(normalizeTranslationText(value), 'utf8').digest('hex');
}

export function createTranslationUnitIdentity(input) {
  assertPlainObject(input, 'translation identity input');
  assertExactKeys(input, CREATE_KEYS, 'translation identity input');

  const sourceLocale = normalizeLocale(input.sourceLocale, 'sourceLocale');
  const targetLocale = normalizeLocale(input.targetLocale, 'targetLocale');
  if (sourceLocale.split('-')[0] === targetLocale.split('-')[0]) {
    throw new TypeError('sourceLocale and targetLocale languages must differ');
  }
  const fieldPath = validateFieldPath(input.fieldPath);
  const normalizedSource = normalizeTranslationText(input.sourceText);
  if (normalizedSource.trim().length === 0) {
    throw new TypeError('sourceText must contain non-whitespace content');
  }
  const sourceHash = createHash('sha256').update(normalizedSource, 'utf8').digest('hex');
  const key = keyFromParts({ sourceLocale, targetLocale, fieldPath, sourceHash });

  return Object.freeze({
    schemaVersion: TRANSLATION_UNIT_IDENTITY_SCHEMA_VERSION,
    sourceLocale,
    targetLocale,
    fieldPath,
    sourceHash,
    key,
  });
}

export function validateTranslationUnitIdentity(identity) {
  assertPlainObject(identity, 'stored translation identity');
  assertExactKeys(identity, STORED_KEYS, 'stored translation identity');
  if (identity.schemaVersion !== TRANSLATION_UNIT_IDENTITY_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation identity schemaVersion');
  }
  const sourceLocale = normalizeLocale(identity.sourceLocale, 'sourceLocale');
  const targetLocale = normalizeLocale(identity.targetLocale, 'targetLocale');
  if (
    sourceLocale !== identity.sourceLocale
    || targetLocale !== identity.targetLocale
    || sourceLocale.split('-')[0] === targetLocale.split('-')[0]
  ) {
    throw new TypeError('stored translation identity locales are not canonical');
  }
  const fieldPath = validateFieldPath(identity.fieldPath);
  if (typeof identity.sourceHash !== 'string' || !SHA256_PATTERN.test(identity.sourceHash)) {
    throw new TypeError('stored translation identity sourceHash is invalid');
  }
  const expectedKey = keyFromParts({
    sourceLocale,
    targetLocale,
    fieldPath,
    sourceHash: identity.sourceHash,
  });
  if (identity.key !== expectedKey) {
    throw new TypeError('stored translation identity key does not match its content');
  }
  return Object.freeze({ ...identity });
}
