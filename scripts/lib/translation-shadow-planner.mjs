import { createHash } from 'node:crypto';
import {
  createObservedTranslationLookup,
  normalizeObservedTranslationProvenance,
} from './content-addressed-translation-memory.mjs';
import { createTranslationUnitIdentity, normalizeTranslationText } from './translation-unit-identity.mjs';

export const TRANSLATION_SHADOW_PLAN_SCHEMA_VERSION = 1;

const UNIT_KEYS = new Set([
  'existingTranslation',
  'fieldPath',
  'provenance',
  'sourceLocale',
  'sourceText',
  'targetLocale',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identityInputFrom(unit) {
  return {
    sourceLocale: unit.sourceLocale,
    targetLocale: unit.targetLocale,
    fieldPath: unit.fieldPath,
    sourceText: unit.sourceText,
  };
}

function invalidPlan(inputIndex, decision, reasonCode) {
  return {
    inputIndex,
    decision,
    reasonCode,
    identity: null,
    provenance: null,
    candidateCount: 0,
    candidates: [],
  };
}

function cloneCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    translationHash: candidate.translationHash,
    trust: 'observed',
    provenanceStoredCount: candidate.provenance.length,
    provenanceTruncated: candidate.provenanceTruncated,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('shadow planner input contains a non-JSON value');
  return serialized;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function planTranslationShadow(input) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'memory,units') {
    throw new TypeError('shadow planner input has an unsupported schema');
  }
  if (!Array.isArray(input.units)) {
    throw new TypeError('shadow planner units must be an array');
  }
  const lookupIndex = createObservedTranslationLookup(input.memory);
  const memory = lookupIndex.memory;
  const plans = input.units.map((unit, inputIndex) => {
    if (!isPlainObject(unit) || Object.keys(unit).some((key) => !UNIT_KEYS.has(key))) {
      return invalidPlan(inputIndex, 'invalid_unit', 'unsupported_unit_schema');
    }
    const required = ['fieldPath', 'sourceLocale', 'sourceText', 'targetLocale'];
    if (required.some((key) => !(key in unit))) {
      return invalidPlan(inputIndex, 'invalid_identity', 'missing_identity_fields');
    }
    let identity;
    try {
      identity = createTranslationUnitIdentity(identityInputFrom(unit));
    } catch {
      return invalidPlan(inputIndex, 'invalid_identity', 'invalid_identity_fields');
    }
    let provenance;
    try {
      provenance = normalizeObservedTranslationProvenance(unit.provenance);
    } catch {
      return invalidPlan(inputIndex, 'invalid_unit', 'invalid_provenance');
    }
    if ('existingTranslation' in unit && unit.existingTranslation !== null && typeof unit.existingTranslation !== 'string') {
      return invalidPlan(inputIndex, 'invalid_unit', 'invalid_existing_translation');
    }
    const existing = typeof unit.existingTranslation === 'string'
      ? normalizeTranslationText(unit.existingTranslation)
      : '';
    if (existing.trim().length > 0) {
      return {
        inputIndex,
        decision: 'existing_translation_present_unvalidated',
        identity,
        provenance,
        candidateCount: 0,
        candidates: [],
      };
    }

    const lookup = lookupIndex.lookup(unit);
    return {
      inputIndex,
      decision: lookup.status,
      identity,
      provenance,
      candidateCount: lookup.candidates.length,
      candidates: lookup.candidates.map(cloneCandidate),
    };
  });

  const summary = {
    total: plans.length,
    exact_observed_hit: 0,
    conflicting_candidates: 0,
    missing_translation: 0,
    invalid_identity: 0,
    invalid_unit: 0,
    existing_translation_present_unvalidated: 0,
  };
  for (const plan of plans) summary[plan.decision] += 1;

  return {
    schemaVersion: TRANSLATION_SHADOW_PLAN_SCHEMA_VERSION,
    digests: {
      input: `sha256:${sha256(canonicalJson({ schemaVersion: 1, units: input.units }))}`,
      memory: `sha256:${sha256(`${JSON.stringify(memory, null, 2)}\n`)}`,
    },
    summary,
    plans,
  };
}
