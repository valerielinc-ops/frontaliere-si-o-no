#!/usr/bin/env node

/**
 * Bounded policy for an open durable-ledger PR.
 *
 * A workflow_run burst must not keep changing the same PR forever. Once the
 * epoch reaches either limit, the current source run is deliberately deferred
 * and will be recovered by the event-driven bridge or the reconciler after the
 * open PR reaches a terminal state.
 */
import { pathToFileURL } from 'node:url';

export const LEDGER_EPOCH_LIMITS = Object.freeze({
  maxBatches: 4,
  maxAgeMinutes: 20,
});

export const LEDGER_BATCH_BRANCH_RE = /^chore\/loop-fleet-ledger-L(?:[0-9]|1[01])-[0-9]+-[0-9]+$/u;
export const LIFECYCLE_LEDGER_BRANCH_RE = /^chore\/loop-fleet-ledger-lifecycle-[0-9]+-[0-9]+$/u;

export function isBridgeLedgerBranch(branch) {
  return branch === 'chore/loop-fleet-ledger' || LEDGER_BATCH_BRANCH_RE.test(String(branch || ''));
}

export function isLifecycleLedgerBranch(branch) {
  return LIFECYCLE_LEDGER_BRANCH_RE.test(String(branch || ''));
}

export function buildLedgerBatchBranch({ loopId, runId, attempt } = {}) {
  if (!/^L(?:[0-9]|1[01])$/u.test(String(loopId || ''))) {
    throw new TypeError('loopId must be L0-L11');
  }
  for (const [value, name] of [[runId, 'runId'], [attempt, 'attempt']]) {
    if (!/^\d+$/u.test(String(value || ''))) throw new TypeError(`${name} must be numeric`);
  }
  return `chore/loop-fleet-ledger-${loopId}-${runId}-${attempt}`;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Decide whether another source batch may be appended to the open PR epoch.
 * Unknown age is fail-closed: without a trustworthy timestamp we cannot prove
 * that the epoch is still within its liveness budget.
 */
export function ledgerEpochDecision({
  openPr = false,
  batchCount = 0,
  ageMinutes = null,
  limits = LEDGER_EPOCH_LIMITS,
} = {}) {
  if (typeof openPr !== 'boolean') throw new TypeError('openPr must be boolean');
  const batches = nonNegativeInteger(batchCount, 'batchCount');
  if (!limits || !Number.isSafeInteger(limits.maxBatches) || limits.maxBatches < 1) {
    throw new TypeError('limits.maxBatches must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.maxAgeMinutes) || limits.maxAgeMinutes < 1) {
    throw new TypeError('limits.maxAgeMinutes must be a positive safe integer');
  }
  if (ageMinutes !== null) nonNegativeInteger(ageMinutes, 'ageMinutes');

  if (!openPr) {
    return {
      allow: true,
      route: 'canonical-branch',
      preserveSource: true,
      reason: 'no-open-epoch',
      batchCount: batches,
      ageMinutes,
    };
  }
  if (batches >= limits.maxBatches) {
    return {
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'batch-cap-reached',
      batchCount: batches,
      ageMinutes,
      maxBatches: limits.maxBatches,
      maxAgeMinutes: limits.maxAgeMinutes,
    };
  }
  if (ageMinutes === null) {
    return {
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'epoch-age-unavailable',
      batchCount: batches,
      ageMinutes,
      maxBatches: limits.maxBatches,
      maxAgeMinutes: limits.maxAgeMinutes,
    };
  }
  if (ageMinutes >= limits.maxAgeMinutes) {
    return {
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'age-cap-reached',
      batchCount: batches,
      ageMinutes,
      maxBatches: limits.maxBatches,
      maxAgeMinutes: limits.maxAgeMinutes,
    };
  }
  return {
    allow: true,
    route: 'open-epoch',
    preserveSource: true,
    reason: 'within-bounds',
    batchCount: batches,
    ageMinutes,
    maxBatches: limits.maxBatches,
    maxAgeMinutes: limits.maxAgeMinutes,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function parseInteger(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/u.test(String(value))) throw new TypeError(`${name} must be a non-negative integer`);
  return Number(value);
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = ledgerEpochDecision({
    openPr: valueAfter(argv, '--open-pr', 'false') === 'true',
    batchCount: parseInteger(valueAfter(argv, '--batch-count', '0'), 'batchCount'),
    ageMinutes: parseInteger(valueAfter(argv, '--age-minutes'), 'ageMinutes'),
  });
  logger.log(JSON.stringify(result));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-epoch-policy] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
