#!/usr/bin/env node
/**
 * Evidence contract for an issue-fix PR in the current Actions run.
 *
 * A PR being OPEN or MERGED is not, by itself, evidence that this run
 * delivered work.  The baseline is captured before the model step and is
 * bound to the run id and attempt.  Delivery is then proven only by a new PR,
 * an OPEN PR whose head SHA changed, or an OPEN -> MERGED transition observed
 * after the run started.  updatedAt is diagnostic data only.
 *
 * The CLI is deliberately read-only.  It is used by issue-fix.yml for the
 * baseline/evaluation and the terminal marker imports the pure evaluator so
 * the delivery predicate has one implementation.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DELIVERY_STATUS = Object.freeze({
  DELIVERED: 'verified-delivery',
  NONE: 'verified-none',
  UNAVAILABLE: 'unavailable',
});

export const PR_LIST_LIMIT = 100;
export const PR_LIST_FIELDS = Object.freeze([
  'number',
  'state',
  'headRefName',
  'headRefOid',
  'createdAt',
  'updatedAt',
  'mergedAt',
]);

const BASELINE_SCHEMA = 1;
const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function identityText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function attemptText(value) {
  const text = identityText(value);
  return text && /^[1-9]\d*$/u.test(text) ? text : null;
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function canonicalTimestamp(value) {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function invalid(reason) {
  return { ok: false, reason };
}

/**
 * Validate the minimum REST/gh PR record shape used by this contract.
 * @param {unknown} record
 * @param {{branch?: string}} [options]
 * @returns {{ok:true, record: object}|{ok:false, reason:string}}
 */
export function normalizePrRecord(record, { branch } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return invalid('pr-record-not-object');
  }
  const number = positiveInteger(record.number);
  const state = typeof record.state === 'string' ? record.state.toUpperCase() : '';
  const headRefName = identityText(record.headRefName);
  const headSha = identityText(record.headRefOid);
  const createdAt = canonicalTimestamp(record.createdAt);
  const updatedAt = canonicalTimestamp(record.updatedAt);
  const mergedAt = record.mergedAt == null ? null : canonicalTimestamp(record.mergedAt);

  if (!number) return invalid('pr-number-invalid');
  if (!PR_STATES.has(state)) return invalid('pr-state-invalid');
  if (!headRefName || (branch && headRefName !== branch)) return invalid('pr-head-invalid');
  if (!headSha) return invalid('pr-head-sha-invalid');
  if (!createdAt || !updatedAt) return invalid('pr-timestamp-invalid');
  if (record.mergedAt != null && !mergedAt) return invalid('pr-merged-at-invalid');
  if (state === 'MERGED' && !mergedAt) return invalid('pr-merged-at-missing');

  return {
    ok: true,
    record: {
      number,
      state,
      headRefName,
      headRefOid: headSha,
      createdAt,
      updatedAt,
      mergedAt,
    },
  };
}

/**
 * Validate a complete PR list. A list at the hard read cap is considered
 * unavailable because it may be truncated; it must never become "none".
 * @param {unknown} records
 * @param {{branch?: string, limit?: number, truncated?: boolean}} [options]
 */
export function normalizePrList(records, {
  branch,
  limit = PR_LIST_LIMIT,
  truncated = false,
} = {}) {
  if (!Array.isArray(records)) return invalid('pr-list-not-array');
  if (truncated || records.length >= limit) return invalid('pr-list-capped');
  const normalized = [];
  for (const record of records) {
    const parsed = normalizePrRecord(record, { branch });
    if (!parsed.ok) return parsed;
    normalized.push(parsed.record);
  }
  return { ok: true, records: normalized };
}

function contextValue(context, key) {
  const value = identityText(context?.[key]);
  return value;
}

function validateContext(context = {}) {
  const runId = contextValue(context, 'runId');
  const runAttempt = attemptText(context?.runAttempt);
  const repo = contextValue(context, 'repo');
  const issue = positiveInteger(context?.issue);
  const branch = contextValue(context, 'branch');
  const runStartedAt = canonicalTimestamp(context?.runStartedAt);
  if (!runId) return invalid('run-id-missing');
  if (!runAttempt) return invalid('run-attempt-invalid');
  if (!repo) return invalid('repo-missing');
  if (!issue) return invalid('issue-invalid');
  if (!branch) return invalid('branch-missing');
  if (!runStartedAt) return invalid('run-started-at-invalid');
  return {
    ok: true,
    context: { runId, runAttempt, repo, issue, branch, runStartedAt },
  };
}

/**
 * Build the attempt-scoped baseline persisted before the model step.
 * @param {{repo:string, issue:string|number, branch:string, runId:string,
 *   runAttempt:string|number, runStartedAt:string, prs:unknown[]}} input
 */
export function createDeliveryBaseline(input) {
  const context = validateContext(input);
  if (!context.ok) return context;
  const list = normalizePrList(input.prs, {
    branch: context.context.branch,
    truncated: input.truncated === true,
  });
  if (!list.ok) return list;
  return {
    ok: true,
    baseline: {
      schema: BASELINE_SCHEMA,
      ...context.context,
      prs: list.records,
    },
  };
}

/**
 * Validate a baseline and bind it to the current run/attempt.
 * @param {unknown} baseline
 * @param {{repo:string, issue:string|number, branch:string, runId:string,
 *   runAttempt:string|number}} context
 */
export function validateDeliveryBaseline(baseline, context) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return invalid('baseline-not-object');
  }
  if (baseline.schema !== BASELINE_SCHEMA) return invalid('baseline-schema-invalid');
  const expected = validateContext({
    ...context,
    runStartedAt: baseline.runStartedAt,
  });
  if (!expected.ok) return expected;
  for (const key of ['repo', 'branch', 'runId', 'runAttempt']) {
    if (String(baseline[key]) !== String(expected.context[key])) {
      return invalid(`baseline-${key}-mismatch`);
    }
  }
  if (String(baseline.issue) !== String(expected.context.issue)) {
    return invalid('baseline-issue-mismatch');
  }
  const list = normalizePrList(baseline.prs, { branch: expected.context.branch });
  if (!list.ok) return list;
  return {
    ok: true,
    baseline: {
      ...expected.context,
      schema: BASELINE_SCHEMA,
      prs: list.records,
    },
  };
}

function recordTimes(record) {
  return {
    createdAt: timestampMs(record.createdAt),
    updatedAt: timestampMs(record.updatedAt),
    mergedAt: record.mergedAt == null ? null : timestampMs(record.mergedAt),
  };
}

function delivered(reason, record) {
  return {
    status: DELIVERY_STATUS.DELIVERED,
    reason,
    prNumber: record.number,
  };
}

/**
 * Evaluate delivery from a pre-run baseline and a complete current snapshot.
 * No `updatedAt`-only path exists by construction.
 */
export function evaluatePrDelivery({
  baseline,
  currentPrs,
  currentPrsComplete = true,
  repo,
  issue,
  branch,
  runId,
  runAttempt,
} = {}) {
  const validBaseline = validateDeliveryBaseline(baseline, {
    repo,
    issue,
    branch,
    runId,
    runAttempt,
  });
  if (!validBaseline.ok) {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: validBaseline.reason, prNumber: null };
  }
  const current = normalizePrList(currentPrs, {
    branch: validBaseline.baseline.branch,
    truncated: currentPrsComplete !== true,
  });
  if (!current.ok) {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: current.reason, prNumber: null };
  }

  const baselineByNumber = new Map(validBaseline.baseline.prs.map((pr) => [pr.number, pr]));
  const startedAt = timestampMs(validBaseline.baseline.runStartedAt);

  for (const record of current.records) {
    const previous = baselineByNumber.get(record.number);
    const currentTimes = recordTimes(record);
    if (!previous) {
      if (currentTimes.createdAt !== null && currentTimes.createdAt >= startedAt) {
        return delivered('new-pr-this-attempt', record);
      }
      return {
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'pr-absent-from-baseline-before-run',
        prNumber: null,
      };
    }

    const previousTimes = recordTimes(previous);
    if (previous.state === 'OPEN' && record.state === 'OPEN') {
      if (previous.headRefOid !== record.headRefOid) {
        if (currentTimes.updatedAt === null || currentTimes.updatedAt < startedAt) {
          return {
            status: DELIVERY_STATUS.UNAVAILABLE,
            reason: 'head-change-before-run',
            prNumber: null,
          };
        }
        return delivered('open-head-changed-this-attempt', record);
      }
      // A label/comment can change updatedAt without changing the delivered head.
      continue;
    }

    if (previous.state === 'OPEN' && record.state === 'MERGED') {
      if (currentTimes.mergedAt !== null && currentTimes.mergedAt >= startedAt) {
        return delivered('open-to-merged-this-attempt', record);
      }
      return {
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'merged-at-before-run',
        prNumber: null,
      };
    }

    // A previously MERGED PR remains historical even when updatedAt moved.
    // CLOSED and unchanged OPEN records are not current delivery evidence.
    void previousTimes;
  }

  return {
    status: DELIVERY_STATUS.NONE,
    reason: 'no-current-delivery-evidence',
    prNumber: null,
  };
}

/**
 * Keep workflow conclusion semantics separate from delivery evidence.
 * @param {{actionOutcome:string, delivery:{status:string, reason?:string, prNumber?:number|null}}} input
 */
export function classifyWorkflowOutcome({ actionOutcome, delivery } = {}) {
  const action = typeof actionOutcome === 'string' ? actionOutcome.toLowerCase() : '';
  const evidence = delivery?.status;
  if (action === 'skipped') {
    return { classification: 'skipped', exitCode: 0, reason: 'intentional-or-preflight-skip' };
  }
  if (action === 'cancelled') {
    return { classification: 'cancelled', exitCode: 0, reason: 'post-steps-not-guaranteed' };
  }
  if (action === 'failure') {
    if (evidence === DELIVERY_STATUS.DELIVERED) {
      return { classification: 'delivered-despite-failure', exitCode: 0, reason: delivery.reason };
    }
    return {
      classification: evidence === DELIVERY_STATUS.UNAVAILABLE ? 'unknown' : 'non-delivery',
      exitCode: 1,
      reason: delivery?.reason || 'no-current-delivery-evidence',
    };
  }
  if (action === 'success') {
    if (evidence === DELIVERY_STATUS.UNAVAILABLE) {
      return { classification: 'unknown', exitCode: 1, reason: delivery.reason };
    }
    return {
      classification: evidence === DELIVERY_STATUS.DELIVERED ? 'delivered' : 'legitimate-no-op',
      exitCode: 0,
      reason: delivery?.reason || 'no-current-delivery-evidence',
    };
  }
  return { classification: 'unknown', exitCode: 1, reason: 'action-outcome-unclassifiable' };
}

function ghJson(args) {
  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'github-read-failed' };
  }
}

function readRunMetadata(repo, runId) {
  const response = ghJson([
    'api',
    `repos/${repo}/actions/runs/${runId}`,
    '--jq',
    '{runStartedAt:(.run_started_at // .created_at),runAttempt:(.run_attempt|tostring)}',
  ]);
  if (!response.ok) return response;
  return { ok: true, value: response.value };
}

function readPrList(repo, branch) {
  const response = ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    String(PR_LIST_LIMIT),
    '--json',
    PR_LIST_FIELDS.join(','),
  ]);
  if (!response.ok) return response;
  return { ok: true, value: response.value, truncated: Array.isArray(response.value) && response.value.length >= PR_LIST_LIMIT };
}

function writeJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function writeText(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, value, 'utf8');
  fs.renameSync(temp, file);
}

function writeLegacyNumbers(file, records) {
  const numbers = records.map((record) => String(record.number)).sort((a, b) => Number(a) - Number(b));
  writeText(file, numbers.join('\n') + (numbers.length ? '\n' : ''));
}

function argsObject(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return result;
}

function requiredArg(args, name) {
  const value = identityText(args[name]);
  if (!value) throw new Error(`missing-${name}`);
  return value;
}

function capture(args) {
  const repo = requiredArg(args, 'repo');
  const branch = requiredArg(args, 'branch');
  const issue = requiredArg(args, 'issue');
  const runId = requiredArg(args, 'run-id');
  const runAttempt = requiredArg(args, 'run-attempt');
  const output = requiredArg(args, 'output');
  const legacyOutput = identityText(args['legacy-output']);
  const run = readRunMetadata(repo, runId);
  if (!run.ok) throw new Error(run.reason);
  if (String(run.value?.runAttempt) !== String(runAttempt)) throw new Error('run-attempt-mismatch');
  const prs = readPrList(repo, branch);
  if (!prs.ok) throw new Error(prs.reason);
  const baseline = createDeliveryBaseline({
    repo,
    issue,
    branch,
    runId,
    runAttempt,
    runStartedAt: run.value?.runStartedAt,
    prs: prs.value,
    truncated: prs.truncated,
  });
  if (!baseline.ok) throw new Error(baseline.reason);
  writeJson(output, baseline.baseline);
  if (legacyOutput) writeLegacyNumbers(legacyOutput, baseline.baseline.prs);
  console.log(JSON.stringify({ ok: true, baseline: output, legacyBaseline: legacyOutput || null }));
}

function evaluate(args) {
  const baselineFile = requiredArg(args, 'baseline');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const repo = requiredArg(args, 'repo');
  const branch = requiredArg(args, 'branch');
  const issue = requiredArg(args, 'issue');
  const runId = requiredArg(args, 'run-id');
  const runAttempt = requiredArg(args, 'run-attempt');
  const prs = readPrList(repo, branch);
  if (!prs.ok) return { status: DELIVERY_STATUS.UNAVAILABLE, reason: prs.reason, prNumber: null };
  return evaluatePrDelivery({
    baseline,
    currentPrs: prs.value,
    currentPrsComplete: !prs.truncated,
    repo,
    issue,
    branch,
    runId,
    runAttempt,
  });
}

function readEvidence(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'evidence-invalid' };
  } catch {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'evidence-unreadable', prNumber: null };
  }
}

function main(argv) {
  const command = argv[0];
  const args = argsObject(argv.slice(1));
  if (command === 'capture') {
    capture(args);
    return;
  }
  if (command === 'evaluate') {
    let result;
    try {
      result = evaluate(args);
    } catch {
      result = { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'delivery-evaluation-failed', prNumber: null };
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'classify') {
    const evidence = readEvidence(requiredArg(args, 'evidence'));
    const result = classifyWorkflowOutcome({
      actionOutcome: requiredArg(args, 'action-outcome'),
      delivery: evidence,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
    return;
  }
  throw new Error('usage: pr-delivery-evidence.mjs capture|evaluate|classify ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`pr-delivery-evidence: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
