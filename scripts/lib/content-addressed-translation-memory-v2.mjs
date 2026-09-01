import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  canonicalTranslationJsonV2,
  createTranslationAttemptKeyV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
  normalizeTranslationVersionV2,
  TRANSLATION_SHA256_PATTERN_V2,
  validateTranslationUnitIdentityV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText, sha256TranslationText } from './translation-unit-identity.mjs';

export const TRANSLATION_MEMORY_V2_SCHEMA_VERSION = 2;
export const MAX_TRANSLATION_EVIDENCE_V2 = 8;

const MEMORY_KEYS = ['records', 'schemaVersion'];
const RECORD_KEYS = ['candidates', 'identity'];
const CANDIDATE_KEYS = [
  'applicability',
  'attemptKey',
  'candidateId',
  'engineVersion',
  'evidence',
  'gateVersion',
  'invalidationReason',
  'outputHash',
  'outputText',
  'status',
];
const RECORD_INPUT_KEYS = ['engineVersion', 'evidence', 'gateVersion', 'identity', 'outputText', 'status'];
const INVALIDATE_INPUT_KEYS = ['candidateId', 'identityKey', 'reasonCode'];
const LOOKUP_KEYS = ['engineVersion', 'gateVersion', 'identity'];
const EVIDENCE_KEYS = ['code', 'digest'];
const REASON_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length > MAX_TRANSLATION_EVIDENCE_V2) {
    throw new TypeError('translation evidence must be a bounded array');
  }
  const normalized = evidence.map((item) => {
    assertTranslationPlainObjectV2(item, 'translation evidence item');
    assertTranslationExactKeysV2(item, EVIDENCE_KEYS, 'translation evidence item');
    if (typeof item.code !== 'string' || !REASON_PATTERN.test(item.code)) {
      throw new TypeError('translation evidence code is invalid');
    }
    if (typeof item.digest !== 'string' || !TRANSLATION_SHA256_PATTERN_V2.test(item.digest)) {
      throw new TypeError('translation evidence digest is invalid');
    }
    return Object.freeze({ code: item.code, digest: item.digest });
  }).sort((left, right) => compareText(
    `${left.code}:${left.digest}`,
    `${right.code}:${right.digest}`,
  ));
  const keys = normalized.map((item) => `${item.code}:${item.digest}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('translation evidence contains duplicates');
  }
  return Object.freeze(normalized);
}

function candidateId(attemptKey, outputHash) {
  return `translation-candidate:v2:${digestTranslationDocumentV2({ attemptKey, outputHash })}`;
}

function validateCandidate(candidate, identity) {
  assertTranslationPlainObjectV2(candidate, 'translation candidate v2');
  assertTranslationExactKeysV2(candidate, CANDIDATE_KEYS, 'translation candidate v2');
  const engineVersion = normalizeTranslationVersionV2(candidate.engineVersion, 'candidate engineVersion');
  const gateVersion = normalizeTranslationVersionV2(candidate.gateVersion, 'candidate gateVersion');
  const expectedAttemptKey = createTranslationAttemptKeyV2({ identity, engineVersion, gateVersion });
  if (candidate.attemptKey !== expectedAttemptKey) {
    throw new TypeError('translation candidate v2 attemptKey does not match its tuple');
  }
  if (!['validated', 'rejected'].includes(candidate.status)) {
    throw new TypeError('translation candidate v2 status is invalid');
  }
  const outputText = normalizeTranslationText(candidate.outputText);
  if (outputText.trim().length === 0 || outputText !== candidate.outputText) {
    throw new TypeError('translation candidate v2 outputText is invalid');
  }
  const outputHash = sha256TranslationText(outputText);
  if (candidate.outputHash !== outputHash || candidate.candidateId !== candidateId(expectedAttemptKey, outputHash)) {
    throw new TypeError('translation candidate v2 content hashes do not match');
  }
  if (!['applicable', 'invalidated'].includes(candidate.applicability)) {
    throw new TypeError('translation candidate v2 applicability is invalid');
  }
  if (
    (candidate.applicability === 'applicable' && candidate.invalidationReason !== null)
    || (candidate.applicability === 'invalidated'
      && (typeof candidate.invalidationReason !== 'string'
        || !REASON_PATTERN.test(candidate.invalidationReason)))
  ) {
    throw new TypeError('translation candidate v2 invalidation is inconsistent');
  }
  return deepFreezeTranslationV2({
    attemptKey: expectedAttemptKey,
    candidateId: candidate.candidateId,
    engineVersion,
    gateVersion,
    outputText,
    outputHash,
    status: candidate.status,
    applicability: candidate.applicability,
    invalidationReason: candidate.invalidationReason,
    evidence: normalizeEvidence(candidate.evidence),
  });
}

export function createEmptyTranslationMemoryV2() {
  return deepFreezeTranslationV2({
    schemaVersion: TRANSLATION_MEMORY_V2_SCHEMA_VERSION,
    records: [],
  });
}

export function validateTranslationMemoryV2(memory) {
  assertTranslationPlainObjectV2(memory, 'translation memory v2');
  assertTranslationExactKeysV2(memory, MEMORY_KEYS, 'translation memory v2');
  if (memory.schemaVersion !== TRANSLATION_MEMORY_V2_SCHEMA_VERSION || !Array.isArray(memory.records)) {
    throw new TypeError('unsupported translation memory v2 schema');
  }
  const seenRecords = new Set();
  const records = memory.records.map((record) => {
    assertTranslationPlainObjectV2(record, 'translation memory v2 record');
    assertTranslationExactKeysV2(record, RECORD_KEYS, 'translation memory v2 record');
    const identity = validateTranslationUnitIdentityV2(record.identity);
    if (seenRecords.has(identity.key)) throw new TypeError('translation memory v2 has duplicate identities');
    seenRecords.add(identity.key);
    if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
      throw new TypeError('translation memory v2 record candidates must be non-empty');
    }
    const candidates = record.candidates.map((candidate) => validateCandidate(candidate, identity));
    const ids = candidates.map((candidate) => candidate.candidateId);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError('translation memory v2 record contains duplicate candidates');
    }
    candidates.sort((left, right) => compareText(left.candidateId, right.candidateId));
    return { identity, candidates };
  });
  records.sort((left, right) => compareText(left.identity.key, right.identity.key));
  return deepFreezeTranslationV2({ schemaVersion: TRANSLATION_MEMORY_V2_SCHEMA_VERSION, records });
}

export function recordTranslationCandidateV2(memory, input) {
  const validatedMemory = validateTranslationMemoryV2(memory);
  assertTranslationPlainObjectV2(input, 'translation candidate v2 input');
  assertTranslationExactKeysV2(input, RECORD_INPUT_KEYS, 'translation candidate v2 input');
  const identity = validateTranslationUnitIdentityV2(input.identity);
  const engineVersion = normalizeTranslationVersionV2(input.engineVersion, 'engineVersion');
  const gateVersion = normalizeTranslationVersionV2(input.gateVersion, 'gateVersion');
  if (!['validated', 'rejected'].includes(input.status)) {
    throw new TypeError('translation candidate v2 input status is invalid');
  }
  const outputText = normalizeTranslationText(input.outputText);
  if (outputText.trim().length === 0) throw new TypeError('outputText must contain non-whitespace content');
  const outputHash = sha256TranslationText(outputText);
  const attemptKey = createTranslationAttemptKeyV2({ identity, engineVersion, gateVersion });
  const candidate = validateCandidate({
    attemptKey,
    candidateId: candidateId(attemptKey, outputHash),
    engineVersion,
    gateVersion,
    outputText,
    outputHash,
    status: input.status,
    applicability: 'applicable',
    invalidationReason: null,
    evidence: input.evidence,
  }, identity);
  const records = structuredClone(validatedMemory.records);
  let record = records.find((item) => item.identity.key === identity.key);
  if (!record) {
    record = { identity, candidates: [] };
    records.push(record);
  }
  const existing = record.candidates.find((item) => item.candidateId === candidate.candidateId);
  if (existing) {
    if (canonicalTranslationJsonV2(existing) !== canonicalTranslationJsonV2(candidate)) {
      throw new TypeError('translation candidate v2 already exists with a different outcome');
    }
    return validatedMemory;
  }
  if (record.candidates.some((item) => (
    item.attemptKey === attemptKey
    && item.applicability === 'applicable'
    && item.status === 'rejected'
  ))) {
    throw new TypeError('translation candidate v2 attempt is negative-cached');
  }
  record.candidates.push(candidate);
  return validateTranslationMemoryV2({ schemaVersion: TRANSLATION_MEMORY_V2_SCHEMA_VERSION, records });
}

export function invalidateTranslationCandidateV2(memory, input) {
  const validatedMemory = validateTranslationMemoryV2(memory);
  assertTranslationPlainObjectV2(input, 'translation invalidation v2 input');
  assertTranslationExactKeysV2(input, INVALIDATE_INPUT_KEYS, 'translation invalidation v2 input');
  if (typeof input.reasonCode !== 'string' || !REASON_PATTERN.test(input.reasonCode)) {
    throw new TypeError('translation invalidation reasonCode is invalid');
  }
  const records = structuredClone(validatedMemory.records);
  const record = records.find((item) => item.identity.key === input.identityKey);
  const candidate = record?.candidates.find((item) => item.candidateId === input.candidateId);
  if (!candidate) throw new TypeError('translation candidate v2 to invalidate was not found');
  if (candidate.applicability === 'invalidated') {
    if (candidate.invalidationReason !== input.reasonCode) {
      throw new TypeError('translation candidate v2 has a conflicting invalidation');
    }
    return validatedMemory;
  }
  candidate.applicability = 'invalidated';
  candidate.invalidationReason = input.reasonCode;
  return validateTranslationMemoryV2({ schemaVersion: TRANSLATION_MEMORY_V2_SCHEMA_VERSION, records });
}

export function lookupTranslationMemoryV2(memory, input) {
  const validatedMemory = validateTranslationMemoryV2(memory);
  assertTranslationPlainObjectV2(input, 'translation lookup v2 input');
  assertTranslationExactKeysV2(input, LOOKUP_KEYS, 'translation lookup v2 input');
  const identity = validateTranslationUnitIdentityV2(input.identity);
  const engineVersion = normalizeTranslationVersionV2(input.engineVersion, 'engineVersion');
  const gateVersion = normalizeTranslationVersionV2(input.gateVersion, 'gateVersion');
  const attemptKey = createTranslationAttemptKeyV2({ identity, engineVersion, gateVersion });
  const candidates = validatedMemory.records
    .find((record) => record.identity.key === identity.key)
    ?.candidates.filter((candidate) => candidate.attemptKey === attemptKey) ?? [];
  const applicableCandidates = candidates.filter((candidate) => candidate.applicability === 'applicable');
  let status = 'missing';
  if (applicableCandidates.length > 1) status = 'conflicting_candidates';
  else if (applicableCandidates[0]?.status === 'validated') status = 'exact_validated_hit';
  else if (applicableCandidates[0]?.status === 'rejected') status = 'negative_cache';
  return deepFreezeTranslationV2({
    status,
    identity,
    attemptKey,
    candidates,
    applicableCandidates,
  });
}

export function serializeTranslationMemoryV2(memory) {
  return `${canonicalTranslationJsonV2(validateTranslationMemoryV2(memory))}\n`;
}
