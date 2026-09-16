#!/usr/bin/env node

/**
 * Independent oracle for L10's verified-decision throughput.
 *
 * The health ledger is produced by the fleet recorder, so it cannot be its
 * own oracle. This module joins the canonical health rows with the separate
 * GitHub Actions run inventory. Missing rows, duplicate identities, SHA
 * mismatches and bounded-source failures stay partial/unmeasurable; they are
 * never converted into a clean zero.
 */
import { buildOutcome } from './loop-fleet-contract.mjs';

const SKIPPED_CONCLUSIONS = new Set(['skipped']);

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function runId(run) {
  const value = run?.databaseId ?? run?.id ?? run?.runId;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function healthRunId(row) {
  const value = row?.execution?.runId ?? row?.runId;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function healthAt(row) {
  return iso(row?.recordedAt) || iso(row?.execution?.recordedAt);
}

function runAt(run) {
  return iso(run?.createdAt) || iso(run?.updatedAt);
}

function withinWindow(stamp, startMs, endMs) {
  const time = Date.parse(stamp || '');
  return Number.isFinite(time) && time >= startMs && time <= endMs;
}

function normalizeWindow(now, windowHours) {
  const end = new Date(now);
  const start = new Date(end.getTime() - windowHours * 3_600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function outcomeRecord({
  outcomeId,
  primaryMetric,
  sourceRefs,
  status,
  independent,
  numerator,
  denominator,
  generatedAt,
  reason,
  allowNumeratorExceedDenominator = false,
  recordedAt,
}) {
  const requiredFields = generatedAt && (status === 'observed' || status === 'zero')
    ? ['generatedAt', 'numerator', 'denominator']
    : (generatedAt ? ['generatedAt'] : []);
  return buildOutcome({
    outcomeId,
    status,
    independent,
    sourceRefs,
    primaryMetric,
    numerator,
    denominator,
    requiredFieldsPresent: requiredFields,
    missingFields: ['generatedAt', 'numerator', 'denominator'].filter((field) => !requiredFields.includes(field)),
    reason,
    observedAt: generatedAt,
    allowNumeratorExceedDenominator,
    recordedAt,
  });
}

/**
 * Join a bounded GitHub Actions run inventory with canonical health rows.
 * `githubRuns` must already be restricted to the registered fleet workflows.
 */
export function buildIndependentFleetControlOutcome({
  healthRecords = [],
  githubRuns = [],
  sourceErrors = [],
  now = new Date(),
  windowHours = 48,
  maxRecords = 1000,
  outcomeId,
  primaryMetric,
  sourceRefs,
  allowNumeratorExceedDenominator = false,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new TypeError('windowHours must be positive');
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
  const generatedAt = now.toISOString();
  const window = normalizeWindow(now, windowHours);
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const errors = Array.isArray(sourceErrors) ? sourceErrors.filter(Boolean).map(String) : ['sourceErrors must be an array'];
  const health = Array.isArray(healthRecords) ? healthRecords.filter((row) => withinWindow(healthAt(row), startMs, endMs)) : [];
  const runs = Array.isArray(githubRuns) ? githubRuns.filter((run) => withinWindow(runAt(run), startMs, endMs)) : [];
  const reconciliationErrors = [];

  if (health.length > maxRecords || runs.length > maxRecords) {
    reconciliationErrors.push(`source exceeds bounded reconciliation window (${Math.max(health.length, runs.length)} > ${maxRecords})`);
  }

  const healthByRun = new Map();
  for (const [index, row] of health.entries()) {
    const id = healthRunId(row);
    if (!object(row) || row.recordType !== 'health' || !object(row.execution) || !id || !text(row.loopId)) {
      reconciliationErrors.push(`health[${index}] has no canonical execution identity`);
      continue;
    }
    if (healthByRun.has(id)) reconciliationErrors.push(`health execution ${id} appears more than once`);
    else healthByRun.set(id, row);
    if (!text(row.execution.sha) || !/^[0-9a-f]{40}$/iu.test(String(row.execution.sha))) {
      reconciliationErrors.push(`health execution ${id} has no full commit SHA`);
    }
    if (typeof row.ok !== 'boolean') reconciliationErrors.push(`health execution ${id} has no boolean ok result`);
    if (row.gateBypass !== false) reconciliationErrors.push(`health execution ${id} has gateBypass other than false`);
  }

  const runById = new Map();
  for (const [index, run] of runs.entries()) {
    const id = runId(run);
    const conclusion = text(run?.conclusion);
    if (!id || !object(run)) {
      reconciliationErrors.push(`githubRuns[${index}] has no run identity`);
      continue;
    }
    if (runById.has(id)) reconciliationErrors.push(`GitHub run ${id} appears more than once`);
    else runById.set(id, run);
    if (run.status !== 'completed' || !conclusion) {
      reconciliationErrors.push(`GitHub run ${id} is not a completed run with a conclusion`);
    }
  }

  const eligibleRuns = [...runById.values()].filter((run) => !SKIPPED_CONCLUSIONS.has(String(run.conclusion).toLowerCase()));
  const eligibleIds = new Set(eligibleRuns.map(runId).filter(Boolean));
  for (const id of eligibleIds) {
    const run = runById.get(id);
    const row = healthByRun.get(id);
    if (!row) {
      reconciliationErrors.push(`GitHub run ${id} has no canonical health row`);
      continue;
    }
    if (run.headSha && row.execution?.sha && String(run.headSha).toLowerCase() !== String(row.execution.sha).toLowerCase()) {
      reconciliationErrors.push(`GitHub run ${id} SHA does not match canonical health execution`);
    }
  }
  for (const id of healthByRun.keys()) {
    if (!eligibleIds.has(id)) reconciliationErrors.push(`canonical health execution ${id} has no eligible GitHub run in the window`);
  }

  const joined = eligibleRuns
    .map((run) => ({ run, health: healthByRun.get(runId(run)) }))
    .filter(({ health }) => health);
  const verifiedDecisions = joined.filter(({ run, health: row }) =>
    String(run.conclusion).toLowerCase() === 'success' && row.ok === true && row.gateBypass === false).length;
  const allSourcesComplete = errors.length === 0
    && reconciliationErrors.length === 0
    && eligibleRuns.length > 0
    && joined.length === eligibleRuns.length;
  const status = allSourcesComplete
    ? (verifiedDecisions === 0 ? 'zero' : 'observed')
    : (eligibleRuns.length || health.length ? 'partial' : 'unmeasurable');
  const measured = allSourcesComplete;
  const outcome = outcomeRecord({
    outcomeId,
    primaryMetric,
    sourceRefs,
    status,
    independent: measured,
    numerator: measured ? verifiedDecisions : null,
    denominator: measured ? eligibleRuns.length : null,
    generatedAt,
    reason: measured
      ? 'GitHub Actions run inventory and canonical health ledger reconcile one-to-one within the bounded window'
      : `independent fleet reconciliation is ${status}; no throughput is inferred from incomplete joins`,
    allowNumeratorExceedDenominator,
    recordedAt: generatedAt,
  });

  return {
    schemaVersion: 1,
    loopId: 'L10',
    generatedAt,
    window,
    source: 'GitHub Actions run inventory + canonical loop health ledger',
    outcome,
    metrics: {
      eligibleRuns: eligibleRuns.length || null,
      verifiedDecisions: measured ? verifiedDecisions : null,
      joinedRuns: joined.length,
      healthRows: health.length,
      githubRuns: runs.length,
      sourceErrors: errors.length,
      reconciliationErrors: reconciliationErrors.length,
    },
    reconciliation: {
      complete: allSourcesComplete,
      sourceErrors: errors,
      errors: reconciliationErrors.slice(0, 100),
      maxRecords,
    },
  };
}
