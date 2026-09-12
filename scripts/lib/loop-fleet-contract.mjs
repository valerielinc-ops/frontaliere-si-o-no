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

export const AUTONOMY_LEVELS = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4']);

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
];

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
  const autonomy = registry.autonomyLevels;
  if (!autonomy || typeof autonomy !== 'object' || AUTONOMY_LEVELS.some((level) => !autonomy[level])) {
    fail('registry must declare every autonomy level A0-A4');
  }
  const loops = requireArray(registry.loops, 'registry loops');
  const ids = new Set();
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
    requireArray(loop.actionClasses, `${id}.actionClasses`);
    requireArray(loop.guardrails, `${id}.guardrails`);
  }
  return { ...registry, loops };
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
