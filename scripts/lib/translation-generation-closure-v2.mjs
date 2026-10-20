import { digestDocument } from './canonical-json-digest.mjs';

export const TRANSLATION_GENERATION_CLOSURE_SCHEMA_VERSION = 1;
export const TRANSLATION_GENERATION_WORKFLOW_FILE = '.github/workflows/translation-schedule-v2-shadow.yml';
export const TRANSLATION_GENERATION_ARTIFACT_NAME = 'translation-scheduler-v2-shadow';
export const TRANSLATION_GENERATION_REQUIRED_MAX = 14;

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PLAN_HASH_PATTERN = /^translation-schedule:v2:[a-f0-9]{64}$/u;
const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/u;

const CLOSURE_KEYS = [
  'canary',
  'generation',
  'plan',
  'providerContract',
  'result',
  'runBinding',
  'schemaVersion',
  'scopeKey',
  'settlement',
  'sourceCommit',
  'stateRef',
  'stateTip',
];
const CANARY_KEYS = ['generationEnabled', 'mainPublish', 'mode', 'name'];
const PLAN_KEYS = ['cursorAfterHash', 'cursorBeforeHash', 'generation', 'hash', 'scanDigest'];
const PROVIDER_KEYS = [
  'costClass',
  'engineVersion',
  'executionClass',
  'exportName',
  'gateVersion',
  'module',
  'schemaVersion',
];
const RESULT_KEYS = ['candidateCounts', 'outcomeCounts', 'selectedJobs', 'selectedUnits', 'status'];
const CANDIDATE_COUNT_KEYS = ['rejected', 'validated'];
const SETTLEMENT_KEYS = ['cursorHash', 'hash', 'metrics', 'planHash'];
const RUN_BINDING_KEYS = [
  'event',
  'repository',
  'runAttempt',
  'runId',
  'workflow',
  'workflowRef',
  'workflowSha',
];

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function validCountMap(value, { requiredKeys = [] } = {}) {
  if (!isPlainObject(value)) return false;
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) return false;
  return Object.values(value).every((count) => boundedInteger(count));
}

function validRunBinding(value) {
  if (!hasExactKeys(value, RUN_BINDING_KEYS)) return false;
  if (value.repository !== null && !nonEmptyText(value.repository)) return false;
  if (value.runId !== null && !RUN_ID_PATTERN.test(value.runId)) return false;
  if (value.runAttempt !== null && !RUN_ID_PATTERN.test(value.runAttempt)) return false;
  if (value.workflow !== TRANSLATION_GENERATION_WORKFLOW_FILE) return false;
  if (value.workflowRef !== null && !nonEmptyText(value.workflowRef)) return false;
  if (value.workflowSha !== null && !SHA_PATTERN.test(value.workflowSha)) return false;
  return value.event === null || ['schedule', 'workflow_dispatch'].includes(value.event);
}

function validProviderContract(value) {
  if (!hasExactKeys(value, PROVIDER_KEYS)) return false;
  return value.schemaVersion === 3
    && value.costClass === 'zero'
    && value.executionClass === 'isolated_callback'
    && nonEmptyText(value.engineVersion) && VERSION_PATTERN.test(value.engineVersion)
    && nonEmptyText(value.gateVersion) && VERSION_PATTERN.test(value.gateVersion)
    && nonEmptyText(value.exportName) && VERSION_PATTERN.test(value.exportName)
    && nonEmptyText(value.module) && VERSION_PATTERN.test(value.module);
}

function validCanary(value) {
  return hasExactKeys(value, CANARY_KEYS)
    && value.name === 'translation-schedule-v2-shadow'
    && value.mode === 'shadow'
    && typeof value.generationEnabled === 'boolean'
    && value.mainPublish === false;
}

function validResult(value) {
  return hasExactKeys(value, RESULT_KEYS)
    && value.status === 'settled'
    && boundedInteger(value.selectedJobs)
    && boundedInteger(value.selectedUnits)
    && hasExactKeys(value.candidateCounts, CANDIDATE_COUNT_KEYS)
    && validCountMap(value.candidateCounts)
    && validCountMap(value.outcomeCounts);
}

function validPlan(value, generation) {
  return hasExactKeys(value, PLAN_KEYS)
    && PLAN_HASH_PATTERN.test(value.hash ?? '')
    && DIGEST_PATTERN.test(value.scanDigest ?? '')
    && HEX_DIGEST_PATTERN.test(value.cursorBeforeHash ?? '')
    && HEX_DIGEST_PATTERN.test(value.cursorAfterHash ?? '')
    && value.generation === generation;
}

function validSettlement(value, planHash) {
  return hasExactKeys(value, SETTLEMENT_KEYS)
    && HEX_DIGEST_PATTERN.test(value.hash ?? '')
    && PLAN_HASH_PATTERN.test(value.planHash ?? '')
    && value.planHash === planHash
    && HEX_DIGEST_PATTERN.test(value.cursorHash ?? '')
    && isPlainObject(value.metrics);
}

/**
 * Validate the immutable closure payload emitted by one settled scheduler
 * generation. A null run binding is allowed for local unit tests; the live
 * tally separately requires the Actions binding and never treats such a
 * report as live evidence.
 */
export function validateTranslationGenerationClosure(value) {
  if (!hasExactKeys(value, CLOSURE_KEYS)
      || value.schemaVersion !== TRANSLATION_GENERATION_CLOSURE_SCHEMA_VERSION
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !SHA_PATTERN.test(value.sourceCommit ?? '')
      || !REF_PATTERN.test(value.stateRef ?? '') || value.stateRef === 'refs/heads/main'
      || !SHA_PATTERN.test(value.stateTip ?? '')
      || !nonEmptyText(value.scopeKey)
      || !validRunBinding(value.runBinding)
      || !validProviderContract(value.providerContract)
      || !validCanary(value.canary)
      || !validPlan(value.plan, value.generation)
      || !validSettlement(value.settlement, value.plan.hash)
      || !validResult(value.result)) {
    throw new TypeError('translation generation closure is invalid');
  }
  return value;
}

export function digestTranslationGenerationClosure(value) {
  return digestDocument(validateTranslationGenerationClosure(value));
}

export function createTranslationGenerationClosure(input) {
  validateTranslationGenerationClosure(input);
  return Object.freeze({
    ...input,
    canary: Object.freeze({ ...input.canary }),
    plan: Object.freeze({ ...input.plan }),
    providerContract: Object.freeze({ ...input.providerContract }),
    result: Object.freeze({
      ...input.result,
      candidateCounts: Object.freeze({ ...input.result.candidateCounts }),
      outcomeCounts: Object.freeze({ ...input.result.outcomeCounts }),
    }),
    runBinding: Object.freeze({ ...input.runBinding }),
    settlement: Object.freeze({
      ...input.settlement,
      metrics: Object.freeze({ ...input.settlement.metrics }),
    }),
  });
}

export function isTranslationGenerationClosure(value) {
  try {
    validateTranslationGenerationClosure(value);
    return true;
  } catch {
    return false;
  }
}
