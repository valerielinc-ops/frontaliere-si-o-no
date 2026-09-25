import {
  createTranslationUnitIdentity,
  normalizeTranslationText,
  sha256TranslationText,
  validateTranslationUnitIdentity,
} from './translation-unit-identity.mjs';

export const TRANSLATION_MEMORY_SCHEMA_VERSION = 1;
export const MAX_OBSERVED_PROVENANCE_PER_CANDIDATE = 32;

const MEMORY_KEYS = ['records', 'schemaVersion'];
const RECORD_KEYS = ['candidates', 'identity'];
const CANDIDATE_KEYS = [
  'candidateId',
  'provenance',
  'provenanceTruncated',
  'translatedText',
  'translationHash',
  'trust',
];
const PROVENANCE_KEYS = new Set(['jobId', 'jobUrl']);
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

export function normalizeObservedTranslationProvenance(value, { required = false } = {}) {
  if (value === undefined && !required) return null;
  assertPlainObject(value, 'translation provenance');
  const keys = Object.keys(value).sort();
  if (keys.length === 0 || keys.some((key) => !PROVENANCE_KEYS.has(key))) {
    throw new TypeError('translation provenance has an unsupported schema');
  }
  let canonicalJobUrl;
  if ('jobUrl' in value) {
    if (typeof value.jobUrl !== 'string' || value.jobUrl.length === 0 || value.jobUrl.length > 4096) {
      throw new TypeError('translation provenance jobUrl is invalid');
    }
    let parsed;
    try {
      parsed = new URL(value.jobUrl);
    } catch {
      throw new TypeError('translation provenance jobUrl is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError('translation provenance jobUrl must use HTTP or HTTPS');
    }
    if (parsed.username || parsed.password) {
      throw new TypeError('translation provenance jobUrl must not contain credentials');
    }
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|fbclid|msclkid|dclid|ref|referrer|source|campaign|tracking(?:id)?|token|session(?:id)?|cachebuster|_+)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    canonicalJobUrl = parsed.toString();
  }
  if ('jobId' in value) {
    if (
      typeof value.jobId !== 'string'
      || value.jobId.length === 0
      || value.jobId.length > 1024
      || value.jobId !== value.jobId.trim()
    ) {
      throw new TypeError('translation provenance jobId is invalid');
    }
    return Object.freeze({ jobId: value.jobId });
  }
  return Object.freeze({ jobUrl: canonicalJobUrl });
}

function provenanceKey(value) {
  return value.jobId ? `jobId:${value.jobId}` : `jobUrl:${value.jobUrl}`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareProvenance(left, right) {
  return compareText(provenanceKey(left), provenanceKey(right));
}

function compareCandidates(left, right) {
  return compareText(left.translationHash, right.translationHash);
}

function compareRecords(left, right) {
  return compareText(left.identity.key, right.identity.key);
}

function candidateIdFromHash(translationHash) {
  return `translation-output:v1:${translationHash}`;
}

function identityInputFrom(value) {
  return {
    sourceLocale: value.sourceLocale,
    targetLocale: value.targetLocale,
    fieldPath: value.fieldPath,
    sourceText: value.sourceText,
  };
}

function validateCandidate(candidate) {
  assertPlainObject(candidate, 'translation candidate');
  assertExactKeys(candidate, CANDIDATE_KEYS, 'translation candidate');
  if (candidate.trust !== 'observed') {
    throw new TypeError('crawler translation candidates must remain observed');
  }
  if (typeof candidate.translatedText !== 'string' || candidate.translatedText.trim().length === 0) {
    throw new TypeError('translation candidate translatedText is invalid');
  }
  const normalized = normalizeTranslationText(candidate.translatedText);
  if (normalized !== candidate.translatedText) {
    throw new TypeError('translation candidate translatedText is not canonical');
  }
  if (typeof candidate.translationHash !== 'string' || !SHA256_PATTERN.test(candidate.translationHash)) {
    throw new TypeError('translation candidate translationHash is invalid');
  }
  if (sha256TranslationText(candidate.translatedText) !== candidate.translationHash) {
    throw new TypeError('translation candidate translationHash does not match its content');
  }
  if (candidate.candidateId !== candidateIdFromHash(candidate.translationHash)) {
    throw new TypeError('translation candidate candidateId does not match its content');
  }
  if (!Array.isArray(candidate.provenance) || candidate.provenance.length === 0) {
    throw new TypeError('translation candidate provenance must be a non-empty array');
  }
  const provenance = candidate.provenance.map((item) => {
    const normalized = normalizeObservedTranslationProvenance(item, { required: true });
    const originalKeys = Object.keys(item).sort();
    const normalizedKeys = Object.keys(normalized).sort();
    if (
      originalKeys.length !== normalizedKeys.length
      || originalKeys.some((key, index) => key !== normalizedKeys[index] || item[key] !== normalized[key])
    ) {
      throw new TypeError('stored translation provenance is not canonical');
    }
    return normalized;
  });
  const keys = provenance.map(provenanceKey);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('translation candidate contains duplicate provenance');
  }
  provenance.sort(compareProvenance);
  if (provenance.length > MAX_OBSERVED_PROVENANCE_PER_CANDIDATE) {
    throw new TypeError('translation candidate provenance exceeds its bounded sample');
  }
  if (typeof candidate.provenanceTruncated !== 'boolean') {
    throw new TypeError('translation candidate provenanceTruncated is invalid');
  }
  if (candidate.provenanceTruncated && provenance.length !== MAX_OBSERVED_PROVENANCE_PER_CANDIDATE) {
    throw new TypeError('truncated translation provenance must retain a full bounded sample');
  }
  return Object.freeze({
    candidateId: candidate.candidateId,
    translationHash: candidate.translationHash,
    translatedText: candidate.translatedText,
    trust: 'observed',
    provenance: Object.freeze(provenance),
    provenanceTruncated: candidate.provenanceTruncated,
  });
}

export function createEmptyTranslationMemory() {
  return Object.freeze({
    schemaVersion: TRANSLATION_MEMORY_SCHEMA_VERSION,
    records: Object.freeze([]),
  });
}

export function validateTranslationMemory(memory) {
  assertPlainObject(memory, 'translation memory');
  assertExactKeys(memory, MEMORY_KEYS, 'translation memory');
  if (memory.schemaVersion !== TRANSLATION_MEMORY_SCHEMA_VERSION || !Array.isArray(memory.records)) {
    throw new TypeError('unsupported translation memory schema');
  }

  const recordKeys = new Set();
  const records = memory.records.map((record) => {
    assertPlainObject(record, 'translation memory record');
    assertExactKeys(record, RECORD_KEYS, 'translation memory record');
    const identity = validateTranslationUnitIdentity(record.identity);
    if (recordKeys.has(identity.key)) {
      throw new TypeError('translation memory contains duplicate identities');
    }
    recordKeys.add(identity.key);
    if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
      throw new TypeError('translation memory record candidates must be a non-empty array');
    }
    const candidates = record.candidates.map(validateCandidate);
    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new TypeError('translation memory record contains duplicate candidates');
    }
    candidates.sort(compareCandidates);
    return Object.freeze({ identity, candidates: Object.freeze(candidates) });
  });
  records.sort(compareRecords);
  return Object.freeze({
    schemaVersion: TRANSLATION_MEMORY_SCHEMA_VERSION,
    records: Object.freeze(records),
  });
}

function normalizeObservation(observation) {
  assertPlainObject(observation, 'translation observation');
  const allowedKeys = new Set([
    'fieldPath',
    'provenance',
    'sourceLocale',
    'sourceText',
    'targetLocale',
    'translatedText',
  ]);
  const actualKeys = Object.keys(observation);
  if (actualKeys.some((key) => !allowedKeys.has(key)) || actualKeys.length !== allowedKeys.size) {
    throw new TypeError('translation observation has an unsupported schema');
  }
  const identity = createTranslationUnitIdentity(identityInputFrom(observation));
  const provenance = normalizeObservedTranslationProvenance(observation.provenance, { required: true });
  const translatedText = normalizeTranslationText(observation.translatedText);
  if (translatedText.trim().length === 0) {
    throw new TypeError('translatedText must contain non-whitespace content');
  }
  const translationHash = sha256TranslationText(translatedText);
  return {
    identity,
    provenance,
    translatedText,
    translationHash,
    candidateId: candidateIdFromHash(translationHash),
  };
}

function mutableRecordsFrom(memory) {
  return memory.records.map((record) => ({
    identity: record.identity,
    candidates: record.candidates.map((candidate) => ({
      ...candidate,
      provenance: candidate.provenance.map((item) => ({ ...item })),
    })),
  }));
}

export function observeTranslations(memory, observations) {
  const validatedMemory = validateTranslationMemory(memory);
  if (!Array.isArray(observations)) {
    throw new TypeError('translation observations must be an array');
  }
  const normalizedObservations = observations.map(normalizeObservation);
  if (normalizedObservations.length === 0) return validatedMemory;

  const records = mutableRecordsFrom(validatedMemory);
  const recordsByKey = new Map(records.map((record) => [record.identity.key, record]));
  const candidateIndexesByRecordKey = new Map(records.map((record) => [
    record.identity.key,
    {
      candidatesByHash: new Map(record.candidates.map((candidate) => [candidate.translationHash, candidate])),
    },
  ]));
  const incomingProvenanceByCandidate = new Map();
  for (const observation of normalizedObservations) {
    let record = recordsByKey.get(observation.identity.key);
    if (!record) {
      record = { identity: observation.identity, candidates: [] };
      records.push(record);
      recordsByKey.set(observation.identity.key, record);
      candidateIndexesByRecordKey.set(observation.identity.key, {
        candidatesByHash: new Map(),
      });
    }
    const candidateIndexes = candidateIndexesByRecordKey.get(observation.identity.key);
    let candidate = candidateIndexes.candidatesByHash.get(observation.translationHash);
    if (!candidate) {
      candidate = {
        candidateId: observation.candidateId,
        translationHash: observation.translationHash,
        translatedText: observation.translatedText,
        trust: 'observed',
        provenance: [],
        provenanceTruncated: false,
      };
      record.candidates.push(candidate);
      candidateIndexes.candidatesByHash.set(observation.translationHash, candidate);
    }
    if (candidate.translatedText !== observation.translatedText) {
      throw new TypeError('translation hash collision detected');
    }
    const candidateKey = `${observation.identity.key}\u0000${observation.translationHash}`;
    let incoming = incomingProvenanceByCandidate.get(candidateKey);
    if (!incoming) {
      incoming = { candidate, provenanceByKey: new Map() };
      incomingProvenanceByCandidate.set(candidateKey, incoming);
    }
    incoming.provenanceByKey.set(provenanceKey(observation.provenance), observation.provenance);
  }

  for (const { candidate, provenanceByKey } of incomingProvenanceByCandidate.values()) {
    const combined = new Map(candidate.provenance.map((item) => [provenanceKey(item), item]));
    for (const [key, provenance] of provenanceByKey) combined.set(key, provenance);
    const sorted = [...combined.values()].sort(compareProvenance);
    candidate.provenanceTruncated = candidate.provenanceTruncated
      || sorted.length > MAX_OBSERVED_PROVENANCE_PER_CANDIDATE;
    candidate.provenance = sorted.slice(0, MAX_OBSERVED_PROVENANCE_PER_CANDIDATE);
  }

  return validateTranslationMemory({
    schemaVersion: TRANSLATION_MEMORY_SCHEMA_VERSION,
    records,
  });
}

const EMPTY_CANDIDATES = Object.freeze([]);

export function createObservedTranslationLookup(memory) {
  const validatedMemory = validateTranslationMemory(memory);
  const recordsByKey = new Map(validatedMemory.records.map((record) => [record.identity.key, record]));
  return Object.freeze({
    memory: validatedMemory,
    lookup(unit) {
      assertPlainObject(unit, 'translation lookup');
      const identity = createTranslationUnitIdentity(identityInputFrom(unit));
      const candidates = recordsByKey.get(identity.key)?.candidates ?? EMPTY_CANDIDATES;
      return Object.freeze({
        status: candidates.length === 0
          ? 'missing_translation'
          : candidates.length === 1
            ? 'exact_observed_hit'
            : 'conflicting_candidates',
        identity,
        candidates,
      });
    },
  });
}

export function lookupObservedTranslation(memory, unit) {
  return createObservedTranslationLookup(memory).lookup(unit);
}

/**
 * Deterministic shadow fixture/interchange format only.
 *
 * This monolithic JSON is deliberately not a persistence contract for the
 * production corpus. A future durable translation memory must be sharded so a
 * large history is never parsed, cloned, or rewritten as one Actions artifact.
 */
export function serializeTranslationMemory(memory) {
  return `${JSON.stringify(validateTranslationMemory(memory), null, 2)}\n`;
}
