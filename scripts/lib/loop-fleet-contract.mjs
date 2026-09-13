#!/usr/bin/env node

/**
 * Shared contract for the loop fleet.
 *
 * The fleet records observations separately from decisions. A missing source
 * is not a zero, and an agent cannot make its own prose the oracle for the
 * result it claims to have produced. This module is deliberately dependency
 * free so every scheduled loop can use it in a sparse checkout.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOOP_STATES = Object.freeze([
  'unmeasurable',
  'observing',
  'candidate',
  'canary',
  'adopted',
  'rolled_back',
  'inconclusive',
]);

export const QUALITY_STATES = Object.freeze([
  'observed',
  'zero',
  'missing',
  'stale',
  'partial',
  'unmeasurable',
]);

// Outcome status deliberately mirrors quality status. A healthy-looking run
// without an independently joined outcome is still not a measured outcome.
export const OUTCOME_STATES = Object.freeze([...QUALITY_STATES]);

export const AUTONOMY_LEVELS = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4']);

export const AUTONOMY_ORDER = Object.freeze({ A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 });

// Lifecycle events are deliberately narrower than the loop state machine:
// the first two are emitted by the recorder, while the remaining events can
// only be asserted by an independent PR/Actions observer.  In particular,
// the recorder must never infer a merge or a rollback from a local decision.
export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  'candidate',
  'owner_assigned',
  'pr_opened',
  'tests_passed',
  'review_approved',
  'merged',
  'post_merge_verified',
  'rollback_requested',
  'rolled_back',
  'inconclusive',
]);

export const REQUIRED_LIFECYCLE_EVENT_TYPES = Object.freeze([
  'candidate',
  'owner_assigned',
  'pr_opened',
  'tests_passed',
  'review_approved',
  'merged',
  'post_merge_verified',
]);

const NON_MEASURABLE_QUALITY = new Set(['missing', 'partial', 'unmeasurable']);
const REQUIRED_LOOP_FIELDS = [
  'loopId',
  'goal',
  'owner',
  'oracle',
  'cadence',
  'primaryMetric',
  'minimumSample',
  'maxAutonomy',
  'actionClasses',
  'guardrails',
  'sourceRefs',
  'outcome',
  'lifecycle',
];

const LIFECYCLE_FIELDS = Object.freeze([
  'candidateTtlHours',
  'ownerSlaHours',
  'postMergeVerificationHours',
  'rollbackOwner',
]);

function fail(message) {
  throw new TypeError(`loop-fleet contract: ${message}`);
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}

function requirePositiveInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
    fail(`${name} must be an ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return value;
}

function requireIso(value, name) {
  const text = requireText(value, name);
  if (!Number.isFinite(Date.parse(text))) fail(`${name} must be an ISO timestamp`);
  return text;
}

function requireArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
  return value;
}

function requireTextArray(value, name) {
  requireArray(value, name);
  const seen = new Set();
  for (const item of value) {
    const text = requireText(item, `${name} item`);
    if (seen.has(text)) fail(`${name} contains duplicate ${text}`);
    seen.add(text);
  }
  return value;
}

function requireTextArrayAllowEmpty(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  const seen = new Set();
  for (const item of value) {
    const text = requireText(item, `${name} item`);
    if (seen.has(text)) fail(`${name} contains duplicate ${text}`);
    seen.add(text);
  }
  return value;
}

function requireOutcomeContract(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  if (value.allowNumeratorExceedDenominator !== undefined
      && typeof value.allowNumeratorExceedDenominator !== 'boolean') {
    fail(`${name}.allowNumeratorExceedDenominator must be boolean`);
  }
  return {
    outcomeId: requireText(value.outcomeId, `${name}.outcomeId`),
    sourceRefs: [...requireTextArray(value.sourceRefs, `${name}.sourceRefs`)],
    requiredFields: [...requireTextArray(value.requiredFields, `${name}.requiredFields`)],
    allowNumeratorExceedDenominator: value.allowNumeratorExceedDenominator === true,
  };
}

function requireLifecycle(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!LIFECYCLE_FIELDS.includes(key)) fail(`${name}.${key} is not a supported lifecycle field`);
  }
  return {
    candidateTtlHours: requirePositiveInteger(value.candidateTtlHours, `${name}.candidateTtlHours`),
    ownerSlaHours: requirePositiveInteger(value.ownerSlaHours, `${name}.ownerSlaHours`),
    postMergeVerificationHours: requirePositiveInteger(value.postMergeVerificationHours, `${name}.postMergeVerificationHours`),
    rollbackOwner: requireText(value.rollbackOwner, `${name}.rollbackOwner`),
  };
}

function requireSourceCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('registry sourceCatalog must be an object');
  const entries = Object.entries(value);
  if (entries.length === 0) fail('registry sourceCatalog must not be empty');
  const catalog = {};
  for (const [key, label] of entries) {
    const sourceKey = requireText(key, 'sourceCatalog key');
    catalog[sourceKey] = requireText(label, `sourceCatalog.${sourceKey}`);
  }
  return catalog;
}

function finiteOrNull(value, name) {
  if (value !== null && (!Number.isFinite(value) || typeof value !== 'number')) {
    fail(`${name} must be a finite number or null`);
  }
  return value;
}

export function validateLoopRegistry(registry) {
  if (!registry || typeof registry !== 'object') fail('registry must be an object');
  if (registry.schemaVersion !== 1) fail('registry schemaVersion must be 1');
  if (!Array.isArray(registry.states) || JSON.stringify(registry.states) !== JSON.stringify(LOOP_STATES)) {
    fail('registry states do not match the shared state machine');
  }
  if (!Array.isArray(registry.qualityStates) || JSON.stringify(registry.qualityStates) !== JSON.stringify(QUALITY_STATES)) {
    fail('registry qualityStates do not match the shared quality states');
  }
  const sourceCatalog = requireSourceCatalog(registry.sourceCatalog);
  const autonomy = registry.autonomyLevels;
  if (!autonomy || typeof autonomy !== 'object' || AUTONOMY_LEVELS.some((level) => !autonomy[level])) {
    fail('registry must declare every autonomy level A0-A4');
  }
  const loops = requireArray(registry.loops, 'registry loops');
  const normalizedLoops = [];
  const ids = new Set();
  const outcomeIds = new Set();
  const declaredActionClasses = new Set();
  for (const loop of loops) {
    if (!loop || typeof loop !== 'object') fail('each loop must be an object');
    for (const field of REQUIRED_LOOP_FIELDS) {
      if (!(field in loop)) fail(`${field} missing for loop`);
    }
    const id = requireText(loop.loopId, 'loopId');
    if (ids.has(id)) fail(`duplicate loopId ${id}`);
    ids.add(id);
    requireText(loop.goal, `${id}.goal`);
    requireText(loop.owner, `${id}.owner`);
    requireText(loop.oracle, `${id}.oracle`);
    requireText(loop.cadence, `${id}.cadence`);
    requireText(loop.primaryMetric, `${id}.primaryMetric`);
    requirePositiveInteger(loop.minimumSample, `${id}.minimumSample`);
    if (!AUTONOMY_LEVELS.includes(loop.maxAutonomy)) fail(`${id}.maxAutonomy is not A0-A4`);
    requireTextArray(loop.actionClasses, `${id}.actionClasses`);
    requireTextArray(loop.guardrails, `${id}.guardrails`);
    requireTextArray(loop.sourceRefs, `${id}.sourceRefs`);
    for (const sourceRef of loop.sourceRefs) {
      if (!Object.hasOwn(sourceCatalog, sourceRef)) fail(`${id}.sourceRefs references undeclared ${sourceRef}`);
    }
    const outcome = requireOutcomeContract(loop.outcome, `${id}.outcome`);
    if (outcomeIds.has(outcome.outcomeId)) fail(`duplicate outcomeId ${outcome.outcomeId}`);
    outcomeIds.add(outcome.outcomeId);
    for (const sourceRef of outcome.sourceRefs) {
      if (!Object.hasOwn(sourceCatalog, sourceRef)) fail(`${id}.outcome.sourceRefs references undeclared ${sourceRef}`);
      if (!loop.sourceRefs.includes(sourceRef)) fail(`${id}.outcome.sourceRefs is not declared by ${id}.sourceRefs: ${sourceRef}`);
    }
    const lifecycle = requireLifecycle(loop.lifecycle, `${id}.lifecycle`);
    for (const actionClass of loop.actionClasses) {
      for (const part of actionClass.split('+').map((value) => value.trim()).filter(Boolean)) {
        declaredActionClasses.add(part);
      }
    }
    normalizedLoops.push({ ...loop, sourceRefs: [...loop.sourceRefs], outcome, lifecycle });
  }
  const actionAutonomyMap = registry.actionAutonomy;
  if (!actionAutonomyMap || typeof actionAutonomyMap !== 'object' || Array.isArray(actionAutonomyMap)) {
    fail('registry must declare actionAutonomy for every action class');
  }
  for (const [actionClass, level] of Object.entries(actionAutonomyMap)) {
    requireText(actionClass, 'actionAutonomy key');
    if (!AUTONOMY_LEVELS.includes(level)) fail(`actionAutonomy.${actionClass} is not A0-A4`);
    if (!declaredActionClasses.has(actionClass)) fail(`actionAutonomy.${actionClass} is not declared by any loop`);
  }
  for (const actionClass of declaredActionClasses) {
    if (!Object.hasOwn(actionAutonomyMap, actionClass)) fail(`actionAutonomy is missing ${actionClass}`);
  }
  return { ...registry, sourceCatalog, loops: normalizedLoops, actionAutonomy: { ...actionAutonomyMap } };
}

export function actionClassParts(actionClass) {
  const value = requireText(actionClass, 'actionClass');
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) fail('actionClass must contain at least one class');
  return [...new Set(parts)];
}

export function actionAutonomy(actionClass, actionAutonomyMap) {
  const parts = actionClassParts(actionClass);
  if (!actionAutonomyMap || typeof actionAutonomyMap !== 'object' || Array.isArray(actionAutonomyMap)) {
    fail('actionAutonomy mapping is required');
  }
  const unknown = parts.filter((part) => !Object.hasOwn(actionAutonomyMap, part));
  if (unknown.length) fail(`actionClass has no autonomy mapping: ${unknown.join(', ')}`);
  return parts.reduce((highest, part) => {
    const level = actionAutonomyMap[part];
    if (!AUTONOMY_LEVELS.includes(level)) fail(`actionAutonomy.${part} is not A0-A4`);
    return AUTONOMY_ORDER[level] > AUTONOMY_ORDER[highest] ? level : highest;
  }, 'A0');
}

export function findLoopPolicy(registry, loopId) {
  const validated = validateLoopRegistry(registry);
  const policy = validated.loops.find((loop) => loop.loopId === loopId);
  if (!policy) fail(`registry has no policy for ${requireText(loopId, 'loopId')}`);
  return policy;
}

/** Load and validate one loop policy from a repository-local registry file. */
export function loadLoopPolicy(registryPath, loopId) {
  const absolute = path.resolve(registryPath);
  if (!fs.existsSync(absolute)) fail(`registry is missing: ${registryPath}`);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    fail(`registry is invalid JSON: ${error.message}`);
  }
  const validated = validateLoopRegistry(registry);
  const policy = validated.loops.find((loop) => loop.loopId === requireText(loopId, 'loopId'));
  if (!policy) fail(`registry has no policy for ${loopId}`);
  return { registry: validated, policy };
}

/**
 * Load the policy used by a runner and make its minimum sample authoritative.
 * A CLI/test override may strengthen the caller's request, but it may never
 * lower the floor declared by the registry.
 */
export function loadLoopPolicyForRun(registryPath, loopId, requestedMinimumSample) {
  const loaded = loadLoopPolicy(registryPath, loopId);
  const policyMinimumSample = loaded.policy.minimumSample;
  if (requestedMinimumSample !== undefined) {
    if (!Number.isInteger(requestedMinimumSample) || requestedMinimumSample < 1) {
      fail(`${loopId} minimumSample override must be a positive integer`);
    }
    if (requestedMinimumSample < policyMinimumSample) {
      fail(`${loopId} minimumSample override ${requestedMinimumSample} is below registry minimum ${policyMinimumSample}`);
    }
  }
  return {
    ...loaded,
    minimumSample: requestedMinimumSample === undefined
      ? policyMinimumSample
      : Math.max(policyMinimumSample, requestedMinimumSample),
  };
}

export function validateActionClassAgainstPolicy(registry, loopId, actionClass) {
  const validated = validateLoopRegistry(registry);
  const policy = validated.loops.find((loop) => loop.loopId === loopId);
  if (!policy) fail(`registry has no policy for ${requireText(loopId, 'loopId')}`);
  const parts = actionClassParts(actionClass);
  const unsupported = parts.filter((part) => !policy.actionClasses.includes(part));
  if (unsupported.length) {
    fail(`${loopId} actionClass ${actionClass} is not allowed by registry: ${unsupported.join(', ')}`);
  }
  const requiredAutonomy = actionAutonomy(actionClass, validated.actionAutonomy);
  if (AUTONOMY_ORDER[requiredAutonomy] > AUTONOMY_ORDER[policy.maxAutonomy]) {
    fail(`${loopId} actionClass ${actionClass} requires ${requiredAutonomy}, registry maximum is ${policy.maxAutonomy}`);
  }
  return {
    loopId,
    actionClass,
    actionClasses: parts,
    requiredAutonomy,
    maxAutonomy: policy.maxAutonomy,
    policy,
  };
}

export function validateOutcomeAgainstPolicy(registry, loopId, outcome) {
  const policy = findLoopPolicy(registry, loopId);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    fail(`${loopId}.outcome must be an object`);
  }
  const normalized = buildOutcome(outcome);
  if (normalized.outcomeId !== policy.outcome.outcomeId) {
    fail(`${loopId}.outcomeId ${normalized.outcomeId} does not match ${policy.outcome.outcomeId}`);
  }
  if (normalized.primaryMetric !== policy.primaryMetric) {
    fail(`${loopId}.outcome primaryMetric ${normalized.primaryMetric} does not match ${policy.primaryMetric}`);
  }
  if (normalized.allowNumeratorExceedDenominator !== policy.outcome.allowNumeratorExceedDenominator) {
    fail(`${loopId}.outcome denominator policy does not match the registry`);
  }
  const missingSourceRefs = policy.outcome.sourceRefs.filter((sourceRef) => !normalized.sourceRefs.includes(sourceRef));
  const extraSourceRefs = normalized.sourceRefs.filter((sourceRef) => !policy.outcome.sourceRefs.includes(sourceRef));
  if (missingSourceRefs.length || extraSourceRefs.length) {
    fail(`${loopId}.outcome.sourceRefs must exactly match the registry declaration`);
  }
  const undeclaredPresentFields = normalized.requiredFieldsPresent
    .filter((field) => !policy.outcome.requiredFields.includes(field));
  const undeclaredMissingFields = normalized.missingFields
    .filter((field) => !policy.outcome.requiredFields.includes(field));
  if (undeclaredPresentFields.length || undeclaredMissingFields.length) {
    fail(`${loopId}.outcome field status contains an undeclared field`);
  }
  const missingRequiredFields = policy.outcome.requiredFields.filter((field) => !normalized.requiredFieldsPresent.includes(field));
  if ((normalized.status === 'observed' || normalized.status === 'zero') && missingRequiredFields.length) {
    fail(`${loopId}.outcome is missing required fields: ${missingRequiredFields.join(', ')}`);
  }
  if ((normalized.status === 'observed' || normalized.status === 'zero') && !normalized.independent) {
    fail(`${loopId}.measured outcome must be independent`);
  }
  return { loopId, policy, outcome: normalized, missingRequiredFields };
}

export function validateDecisionLifecycle(registry, loopId, decision) {
  const policy = findLoopPolicy(registry, loopId);
  if (!decision || typeof decision !== 'object') fail('decision must be an object');
  const startedAt = requireIso(decision.startedAt, `${loopId}.decision.startedAt`);
  const expiresAt = requireIso(decision.expiresAt, `${loopId}.decision.expiresAt`);
  const decidedAt = requireIso(decision.decidedAt, `${loopId}.decision.decidedAt`);
  const startedMs = Date.parse(startedAt);
  const decisionMs = Date.parse(decidedAt);
  const expiresMs = Date.parse(expiresAt);
  if (decisionMs < startedMs) fail(`${loopId}.decision.decidedAt cannot precede startedAt`);
  if (expiresMs < startedMs) fail(`${loopId}.decision.expiresAt cannot precede startedAt`);
  const ttlLimit = decisionMs + policy.lifecycle.candidateTtlHours * 3_600_000;
  if (expiresMs > ttlLimit) {
    fail(`${loopId}.decision.expiresAt exceeds candidate TTL of ${policy.lifecycle.candidateTtlHours} hours`);
  }
  return {
    loopId,
    startedAt,
    decidedAt,
    expiresAt,
    lifecycle: policy.lifecycle,
    withinCandidateTtl: true,
  };
}

export function buildLifecycleEvent({
  eventType,
  loopId,
  candidateId,
  owner,
  sourceRecordId,
  sourceRefs,
  lifecycle,
  occurredAt,
  artifactOrPr = null,
  recordedAt = new Date().toISOString(),
}) {
  if (!LIFECYCLE_EVENT_TYPES.includes(eventType)) fail(`unknown lifecycle event type ${eventType}`);
  requireText(loopId, 'lifecycle event loopId');
  requireText(candidateId, 'lifecycle event candidateId');
  requireText(owner, 'lifecycle event owner');
  requireText(sourceRecordId, 'lifecycle event sourceRecordId');
  requireTextArray(sourceRefs, 'lifecycle event sourceRefs');
  const normalizedLifecycle = requireLifecycle(lifecycle, 'lifecycle event lifecycle');
  requireIso(occurredAt, 'lifecycle event occurredAt');
  if (artifactOrPr !== null) requireText(artifactOrPr, 'lifecycle event artifactOrPr');
  requireIso(recordedAt, 'lifecycle event recordedAt');
  return {
    recordType: 'lifecycle-event',
    schemaVersion: 1,
    eventType,
    loopId: loopId.trim(),
    candidateId: candidateId.trim(),
    owner: owner.trim(),
    sourceRecordId: sourceRecordId.trim(),
    sourceRefs: [...sourceRefs],
    lifecycle: normalizedLifecycle,
    occurredAt,
    artifactOrPr,
    recordedAt,
  };
}

export function validateLifecycleEvent(registry, loopId, event) {
  const policy = findLoopPolicy(registry, loopId);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail(`${loopId}.lifecycle event must be an object`);
  }
  if (event.recordType !== 'lifecycle-event') {
    fail(`${loopId}.lifecycle event recordType is ${event.recordType || 'missing'}`);
  }
  if (event.schemaVersion !== 1) fail(`${loopId}.lifecycle event schemaVersion must be 1`);
  if (event.loopId !== loopId) fail(`${loopId}.lifecycle event belongs to ${event.loopId || 'unknown'}`);
  requireText(event.recordId, `${loopId}.lifecycle event recordId`);
  const normalized = buildLifecycleEvent(event);
  const missingSourceRefs = policy.sourceRefs.filter((sourceRef) => !normalized.sourceRefs.includes(sourceRef));
  const extraSourceRefs = normalized.sourceRefs.filter((sourceRef) => !policy.sourceRefs.includes(sourceRef));
  if (missingSourceRefs.length || extraSourceRefs.length) {
    fail(`${loopId}.lifecycle event sourceRefs must exactly match the registry declaration`);
  }
  if (JSON.stringify(normalized.lifecycle) !== JSON.stringify(policy.lifecycle)) {
    fail(`${loopId}.lifecycle event lifecycle metadata does not match the registry`);
  }
  return { loopId, policy, event: normalized };
}

export function buildObservation({
  loopId,
  goal,
  owner,
  oracle,
  hypothesis,
  sourceSnapshot,
  observationWindow,
  cohort,
  numerator,
  denominator,
  primaryMetric,
  guardrails,
  minimumSample,
  actionClass = 'observe',
  quality = 'unmeasurable',
  allowNumeratorExceedDenominator = false,
  recordedAt = new Date().toISOString(),
}) {
  requireText(loopId, 'loopId');
  requireText(goal, 'goal');
  requireText(owner, 'owner');
  requireText(oracle, 'oracle');
  requireText(hypothesis, 'hypothesis');
  if (!sourceSnapshot || typeof sourceSnapshot !== 'object') fail('sourceSnapshot must be an object');
  if (!observationWindow || typeof observationWindow !== 'object') fail('observationWindow must be an object');
  requireIso(observationWindow.start, 'observationWindow.start');
  requireIso(observationWindow.end, 'observationWindow.end');
  requireText(cohort, 'cohort');
  requireText(primaryMetric, 'primaryMetric');
  requireArray(guardrails, 'guardrails');
  requirePositiveInteger(minimumSample, 'minimumSample');
  requireIso(recordedAt, 'recordedAt');
  if (!QUALITY_STATES.includes(quality)) fail(`unknown quality state ${quality}`);
  finiteOrNull(numerator, 'numerator');
  finiteOrNull(denominator, 'denominator');
  if (NON_MEASURABLE_QUALITY.has(quality) && (numerator !== null || denominator !== null)) {
    fail(`${quality} observations must use null numerator and denominator`);
  }
  if (quality === 'observed' && (numerator === null || denominator === null)) {
    fail('observed observations require numerator and denominator');
  }
  if (denominator !== null && denominator < 0) fail('denominator cannot be negative');
  if (numerator !== null && numerator < 0) fail('numerator cannot be negative');
  if (!allowNumeratorExceedDenominator
      && numerator !== null && denominator !== null && numerator > denominator) {
    fail('numerator cannot exceed denominator');
  }
  return {
    recordType: 'observation',
    schemaVersion: 1,
    loopId: loopId.trim(),
    goal: goal.trim(),
    owner: owner.trim(),
    oracle: oracle.trim(),
    hypothesis: hypothesis.trim(),
    sourceSnapshot,
    observationWindow: {
      start: observationWindow.start,
      end: observationWindow.end,
      timezone: observationWindow.timezone || 'UTC',
    },
    cohort: cohort.trim(),
    numerator,
    denominator,
    primaryMetric: primaryMetric.trim(),
    guardrails: [...guardrails],
    minimumSample,
    actionClass: requireText(actionClass, 'actionClass'),
    quality,
    recordedAt,
  };
}

export function buildOutcome({
  outcomeId,
  status = 'unmeasurable',
  independent = false,
  sourceRefs,
  primaryMetric,
  numerator = null,
  denominator = null,
  requiredFieldsPresent = [],
  missingFields = [],
  reason,
  observedAt = null,
  allowNumeratorExceedDenominator = false,
  recordedAt = new Date().toISOString(),
}) {
  requireText(outcomeId, 'outcomeId');
  if (!OUTCOME_STATES.includes(status)) fail(`unknown outcome status ${status}`);
  if (typeof independent !== 'boolean') fail('outcome independent must be boolean');
  requireTextArray(sourceRefs, 'outcome sourceRefs');
  requireText(primaryMetric, 'outcome primaryMetric');
  requireTextArrayAllowEmpty(requiredFieldsPresent, 'outcome requiredFieldsPresent');
  requireTextArrayAllowEmpty(missingFields, 'outcome missingFields');
  requireText(reason, 'outcome reason');
  if (typeof allowNumeratorExceedDenominator !== 'boolean') {
    fail('outcome allowNumeratorExceedDenominator must be boolean');
  }
  if (observedAt !== null) requireIso(observedAt, 'outcome observedAt');
  requireIso(recordedAt, 'outcome recordedAt');
  finiteOrNull(numerator, 'outcome numerator');
  finiteOrNull(denominator, 'outcome denominator');
  if (NON_MEASURABLE_QUALITY.has(status) && (numerator !== null || denominator !== null)) {
    fail(`${status} outcomes must use null numerator and denominator`);
  }
  if ((status === 'observed' || status === 'zero') && (numerator === null || denominator === null)) {
    fail(`${status} outcomes require numerator and denominator`);
  }
  if (denominator !== null && denominator < 0) fail('outcome denominator cannot be negative');
  if (numerator !== null && numerator < 0) fail('outcome numerator cannot be negative');
  if (!allowNumeratorExceedDenominator
      && denominator !== null && numerator !== null && numerator > denominator) {
    fail('outcome numerator cannot exceed denominator');
  }
  if (status === 'observed' && missingFields.length) {
    fail('observed outcomes cannot have missing fields');
  }
  return {
    recordType: 'outcome',
    schemaVersion: 1,
    outcomeId: outcomeId.trim(),
    status,
    independent,
    sourceRefs: [...sourceRefs],
    primaryMetric: primaryMetric.trim(),
    numerator,
    denominator,
    requiredFieldsPresent: [...requiredFieldsPresent],
    missingFields: [...missingFields],
    reason: reason.trim(),
    observedAt,
    allowNumeratorExceedDenominator,
    recordedAt,
  };
}

export function buildDecision({
  loopId,
  goal,
  owner,
  oracle,
  sourceSnapshot,
  observationWindow,
  cohort,
  decision,
  reason,
  actionClass,
  artifactOrPr = null,
  rollbackPlan,
  startedAt,
  expiresAt,
  decidedAt = new Date().toISOString(),
}) {
  requireText(loopId, 'loopId');
  requireText(goal, 'goal');
  requireText(owner, 'owner');
  requireText(oracle, 'oracle');
  if (!sourceSnapshot || typeof sourceSnapshot !== 'object') fail('sourceSnapshot must be an object');
  if (!observationWindow || typeof observationWindow !== 'object') fail('observationWindow must be an object');
  requireIso(observationWindow.start, 'observationWindow.start');
  requireIso(observationWindow.end, 'observationWindow.end');
  requireText(cohort, 'cohort');
  if (!LOOP_STATES.includes(decision)) fail(`unknown decision state ${decision}`);
  requireText(reason, 'reason');
  requireText(actionClass, 'actionClass');
  requireText(rollbackPlan, 'rollbackPlan');
  if (artifactOrPr !== null) requireText(artifactOrPr, 'artifactOrPr');
  const started = requireIso(startedAt || observationWindow.start, 'startedAt');
  const expires = requireIso(expiresAt || decidedAt, 'expiresAt');
  requireIso(decidedAt, 'decidedAt');
  if (Date.parse(expires) < Date.parse(started)) fail('expiresAt cannot precede startedAt');
  return {
    recordType: 'decision',
    schemaVersion: 1,
    loopId: loopId.trim(),
    goal: goal.trim(),
    owner: owner.trim(),
    oracle: oracle.trim(),
    sourceSnapshot,
    observationWindow,
    cohort: cohort.trim(),
    decision,
    reason: reason.trim(),
    actionClass: actionClass.trim(),
    artifactOrPr,
    rollbackPlan: rollbackPlan.trim(),
    startedAt: started,
    expiresAt: expires,
    decidedAt,
  };
}

export function ratio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

/** Append exactly one JSON record. The file is never rewritten by this helper. */
export function appendJsonl(file, record) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  return target;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}
