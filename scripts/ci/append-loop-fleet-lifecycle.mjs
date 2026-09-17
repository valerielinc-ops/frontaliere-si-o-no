#!/usr/bin/env node

/**
 * Append independently observed lifecycle events to the durable ledger.
 *
 * This helper has no GitHub credentials and no production side effects. The
 * caller must carry the result through the durable ledger branch.
 * Candidate/owner_assigned remain recorder-owned and are rejected here so a
 * downstream observer cannot overwrite the source of lifecycle authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendJsonlSerialized,
  validateLifecycleCandidateTerminalChain,
  validateLifecycleEvent,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const OBSERVED_EVENT_TYPES = new Set([
  'pr_opened',
  'tests_passed',
  'review_approved',
  'merged',
  'post_merge_verified',
  'rollback_requested',
  'rolled_back',
  'inconclusive',
]);
const RECORDER_OWNED_EVENT_TYPES = new Set(['candidate', 'owner_assigned']);
const REQUIRED_PREDECESSOR_CHAIN = Object.freeze({
  pr_opened: Object.freeze(['candidate', 'owner_assigned']),
  tests_passed: Object.freeze(['candidate', 'owner_assigned', 'pr_opened']),
  review_approved: Object.freeze(['candidate', 'owner_assigned', 'pr_opened', 'tests_passed']),
  merged: Object.freeze(['candidate', 'owner_assigned', 'pr_opened', 'tests_passed', 'review_approved']),
  post_merge_verified: Object.freeze([
    'candidate',
    'owner_assigned',
    'pr_opened',
    'tests_passed',
    'review_approved',
    'merged',
  ]),
  rollback_requested: Object.freeze([
    'candidate',
    'owner_assigned',
    'pr_opened',
    'tests_passed',
    'review_approved',
    'merged',
    'post_merge_verified',
  ]),
  rolled_back: Object.freeze([
    'candidate',
    'owner_assigned',
    'pr_opened',
    'tests_passed',
    'review_approved',
    'merged',
    'post_merge_verified',
    'rollback_requested',
  ]),
  // Inconclusive is the explicit TTL terminal for an owned candidate that did
  // not advance into a PR; it intentionally needs no pr_opened.
  inconclusive: Object.freeze(['candidate', 'owner_assigned']),
});
const PREDECESSOR_ORDER_ERRORS = Object.freeze({
  'rollback_requested:post_merge_verified': 'rollback_requested occurs before post_merge_verified',
  'rolled_back:rollback_requested': 'rolled_back occurs before rollback_requested',
});
const SHA_RE = /^[0-9a-f]{40}$/iu;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readJson(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readJsonl(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return [];
  return fs.readFileSync(absolute, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function validateDurableEvent(registry, event, label) {
  if (!object(event)) throw new Error(`${label} is not an object`);
  if (!text(event.recordId)) throw new Error(`${label} has no recordId`);
  if (event.eventType && OBSERVED_EVENT_TYPES.has(event.eventType) === false
      && !['candidate', 'owner_assigned'].includes(event.eventType)) {
    throw new Error(`${label} has unsupported eventType ${event.eventType}`);
  }
  validateLifecycleEvent(registry, event.loopId, event);
  if (!object(event.execution)
      || String(event.execution.loopId || '') !== String(event.loopId || '')
      || !text(event.execution.runId)
      || !/^\d+$/u.test(String(event.execution.runId))
      || !SHA_RE.test(String(event.execution.sha || ''))) {
    throw new Error(`${label} has no durable observer/source execution identity`);
  }
  return event;
}

/**
 * The observer's capture metadata is expected to change when a run retries.
 * The event itself must remain immutable, however: a changed PR, event type or
 * evidence reference under the same deterministic recordId is a real conflict.
 */
function sameRecord(left, right) {
  const { recordedAt: _leftRecordedAt, execution: _leftExecution, ...leftEvent } = left;
  const { recordedAt: _rightRecordedAt, execution: _rightExecution, ...rightEvent } = right;
  return JSON.stringify(leftEvent) === JSON.stringify(rightEvent);
}

function occurredAtMs(event) {
  const timestamp = Date.parse(event?.occurredAt || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateLifecycleTransition(candidateId, priorEvents, event) {
  const eventType = event?.eventType;
  if (RECORDER_OWNED_EVENT_TYPES.has(eventType)) {
    throw new Error(`${candidateId}.lifecycle ${eventType} is recorder-owned`);
  }
  const predecessorTypes = REQUIRED_PREDECESSOR_CHAIN[eventType];
  if (!predecessorTypes) {
    throw new Error(`${candidateId}.lifecycle ${eventType} has no downstream transition rule`);
  }

  const eventTime = occurredAtMs(event);
  if (eventTime === null) {
    throw new Error(`${candidateId}.lifecycle ${eventType} has an invalid occurredAt`);
  }
  const missing = predecessorTypes.filter((predecessorType) =>
    !priorEvents.some((priorEvent) => priorEvent.eventType === predecessorType));
  if (missing.length) {
    throw new Error(
      `${candidateId}.lifecycle ${eventType} requires predecessor chain: ${missing.join(', ')}`,
    );
  }

  let previousTime = Number.NEGATIVE_INFINITY;
  let previousType = null;
  for (const predecessorType of predecessorTypes) {
    const predecessor = priorEvents
      .map((priorEvent, index) => ({ priorEvent, index, time: occurredAtMs(priorEvent) }))
      .filter(({ priorEvent, time }) => priorEvent.eventType === predecessorType
        && time !== null
        && time >= previousTime
        && time <= eventTime)
      .sort((left, right) => left.time - right.time || left.index - right.index)[0];
    if (!predecessor) {
      const orderError = PREDECESSOR_ORDER_ERRORS[`${eventType}:${predecessorType}`];
      throw new Error(
        `${candidateId}.lifecycle ${orderError || `${eventType} occurs before predecessor ${predecessorType}`}`
          + (!orderError && previousType ? ` after ${previousType}` : ''),
      );
    }
    previousTime = predecessor.time;
    previousType = predecessorType;
  }

  // Candidate TTL gates this alternative terminal transition. ownerSlaHours
  // and postMergeVerificationHours stay explicit reporting deadlines: late,
  // independently observed evidence is not silently discarded by the writer.
  if (eventType === 'inconclusive') {
    const candidate = priorEvents
      .filter((priorEvent) => priorEvent.eventType === 'candidate')
      .map((priorEvent) => occurredAtMs(priorEvent))
      .filter((time) => time !== null)
      .sort((left, right) => left - right)[0];
    const ttlHours = Number(event.lifecycle?.candidateTtlHours);
    const ttlDeadline = candidate + ttlHours * 3_600_000;
    if (eventTime < ttlDeadline) {
      throw new Error(
        `${candidateId}.lifecycle inconclusive occurs before candidate TTL deadline `
          + `${new Date(ttlDeadline).toISOString()}`,
      );
    }
  }
}

/** Append new observed events idempotently; conflicting record IDs fail closed. */
export function appendLoopFleetLifecycle({
  eventsFile,
  ledgerDir,
  registryPath = DEFAULT_REGISTRY_PATH,
} = {}) {
  if (!eventsFile) throw new Error('eventsFile is required');
  if (!ledgerDir) throw new Error('ledgerDir is required');
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const input = readJsonl(eventsFile, 'observed lifecycle events');
  for (const [index, event] of input.entries()) {
    validateDurableEvent(registry, event, `observed lifecycle event ${index + 1}`);
    if (!OBSERVED_EVENT_TYPES.has(event.eventType)) {
      throw new Error(`observed lifecycle event ${event.recordId} must be a downstream event, got ${event.eventType}`);
    }
  }

  const target = path.resolve(ledgerDir, 'lifecycle-events.jsonl');
  const existing = readJsonl(target, 'durable lifecycle ledger');
  const byId = new Map();
  const existingByCandidate = new Map();
  for (const [index, event] of existing.entries()) {
    validateDurableEvent(registry, event, `durable lifecycle event ${index + 1}`);
    const previous = byId.get(event.recordId);
    if (previous && !sameRecord(previous, event)) {
      throw new Error(`durable lifecycle ledger has conflicting duplicate ${event.recordId}`);
    }
    byId.set(event.recordId, event);
    if (!existingByCandidate.has(event.candidateId)) existingByCandidate.set(event.candidateId, []);
    existingByCandidate.get(event.candidateId).push(event);
  }

  // Resolve all input conflicts before the first write. Only candidates with a
  // genuinely new record are chain-validated; replaying an already persisted
  // batch must not retroactively reject historical read-only state.
  const newById = new Map();
  for (const event of input) {
    const previous = byId.get(event.recordId) || newById.get(event.recordId);
    if (previous && !sameRecord(previous, event)) {
      throw new Error(`durable lifecycle ledger has conflicting duplicate ${event.recordId}`);
    }
    if (!previous) newById.set(event.recordId, event);
  }

  const candidateEventsToValidate = new Map();
  for (const event of newById.values()) {
    if (!candidateEventsToValidate.has(event.candidateId)) {
      candidateEventsToValidate.set(event.candidateId, [
        ...(existingByCandidate.get(event.candidateId) || []),
      ]);
    }
    const candidateEvents = candidateEventsToValidate.get(event.candidateId);
    validateLifecycleTransition(event.candidateId, candidateEvents, event);
    candidateEvents.push(event);
  }
  for (const [candidateId, candidateEvents] of candidateEventsToValidate.entries()) {
    validateLifecycleCandidateTerminalChain(candidateId, candidateEvents);
  }

  let appended = 0;
  let skipped = 0;
  for (const event of input) {
    const previous = byId.get(event.recordId);
    if (previous) {
      if (!sameRecord(previous, event)) {
        throw new Error(`durable lifecycle ledger has conflicting duplicate ${event.recordId}`);
      }
      skipped += 1;
      continue;
    }
    const result = appendJsonlSerialized(target, event, { label: 'durable lifecycle ledger' });
    byId.set(event.recordId, event);
    if (result.appended) appended += 1;
    else skipped += 1;
  }
  return {
    inputRecords: input.length,
    appended,
    skipped,
    ledgerFile: target,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = appendLoopFleetLifecycle({
    eventsFile: valueAfter(argv, '--events-file'),
    ledgerDir: valueAfter(argv, '--ledger-dir'),
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
  });
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[append-loop-fleet-lifecycle] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
