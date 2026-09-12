#!/usr/bin/env node

/**
 * Collect the evidence produced by one loop into immutable, per-run ledgers.
 *
 * The loop itself owns its domain validation. This recorder owns the common
 * operational contract: one run identity, one canonical observation line,
 * one canonical decision line and one health line. It never writes source,
 * published data or external state. The containing workflow uploads the
 * directory as the durable run artifact.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  actionAutonomy,
  appendJsonl,
  buildDecision,
  buildObservation,
  findLoopPolicy,
  validateActionClassAgainstPolicy,
  validateDecisionLifecycle,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const LOOP_ID_PATTERN = /^L\d+$/u;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function iso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
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

function readOptionalJson(file) {
  if (!file || !fs.existsSync(path.resolve(file))) return null;
  return readJson(file, file);
}

function relativePath(file) {
  const relative = path.relative(process.cwd(), path.resolve(file));
  return relative || path.basename(file);
}

function runContext(now) {
  return {
    repository: text(process.env.GITHUB_REPOSITORY),
    workflow: text(process.env.GITHUB_WORKFLOW),
    event: text(process.env.GITHUB_EVENT_NAME),
    ref: text(process.env.GITHUB_REF),
    sha: text(process.env.GITHUB_SHA),
    runId: text(process.env.GITHUB_RUN_ID) || 'local',
    runAttempt: text(process.env.GITHUB_RUN_ATTEMPT) || '1',
    recordedAt: now.toISOString(),
  };
}

function recordId(type, loopId, record, context) {
  const timestamp = record?.recordedAt || record?.decidedAt || context.recordedAt;
  const basis = [type, loopId, context.repository || '', context.workflow || '', context.runId, context.runAttempt, context.sha || '', timestamp].join('|');
  return `lf-${type}-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

function withExecution(record, type, loopId, context) {
  if (!record) return null;
  return {
    ...record,
    recordId: recordId(type, loopId, record, context),
    execution: context,
  };
}

function appendUnique(file, record) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) {
    const lines = fs.readFileSync(absolute, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let existing;
      try {
        existing = JSON.parse(line);
      } catch (error) {
        throw new Error(`ledger ${file} contains invalid JSON: ${error.message}`);
      }
      if (existing.recordId === record.recordId) return false;
    }
  }
  appendJsonl(absolute, record);
  return true;
}

function validateRecord(record, type, loopId) {
  if (!record || typeof record !== 'object') throw new Error(`${type} record is missing`);
  if (record.recordType !== type) throw new Error(`${type} recordType is ${record.recordType || 'missing'}`);
  if (record.loopId !== loopId) throw new Error(`${type} record belongs to ${record.loopId || 'unknown'}, expected ${loopId}`);
  return record;
}

function policyCheck(registry, loopId, record) {
  try {
    return { ok: true, value: validateActionClassAgainstPolicy(registry, loopId, record.actionClass) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function lifecycleCheck(registry, loopId, record) {
  try {
    return { ok: true, value: validateDecisionLifecycle(registry, loopId, record) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildTechnicalAuditRecords({ report, reportPath, policy, now }) {
  const summary = report?.summary;
  const summaryValid = summary && integer(summary.error) && integer(summary.warning) && integer(summary.info) && integer(summary.total);
  const generatedAt = iso(report?.generatedAt);
  const start = generatedAt && Date.parse(generatedAt) <= now.getTime() ? generatedAt : now.toISOString();
  const quality = !summaryValid
    ? 'unmeasurable'
    : (summary.error === 0 && summary.warning === 0 ? 'observed' : 'partial');
  const actionClass = quality === 'observed' ? 'observe' : 'issue';
  const sourceSnapshot = {
    source: 'technical-operations-audit',
    path: relativePath(reportPath),
    commit: text(report?.commit),
    generatedAt,
    filesScanned: integer(report?.filesScanned) ? report.filesScanned : null,
    summary: summary || null,
  };
  const observation = buildObservation({
    loopId: 'L11',
    goal: policy.goal,
    owner: policy.owner,
    oracle: policy.oracle,
    hypothesis: 'Every workflow must be reachable and reconcile the proof it promises before a technical fix is considered safe.',
    sourceSnapshot,
    observationWindow: { start, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'repository-workflow-inventory',
    numerator: quality === 'observed' ? 1 : null,
    denominator: quality === 'observed' ? 1 : null,
    primaryMetric: policy.primaryMetric,
    guardrails: policy.guardrails,
    minimumSample: policy.minimumSample,
    actionClass,
    quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: 'L11',
    goal: policy.goal,
    owner: policy.owner,
    oracle: policy.oracle,
    sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: quality === 'observed' ? 'observing' : 'candidate',
    reason: summaryValid
      ? (quality === 'observed' ? 'workflow inventory is structurally healthy' : `${summary.error} errors and ${summary.warning} warnings require review`)
      : 'technical operations report is missing a trustworthy summary',
    actionClass,
    rollbackPlan: 'discard the runner-local audit artifact; do not mutate workflows or data from the recorder',
    startedAt: start,
    expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  return {
    observation,
    decision,
    result: {
      loopId: 'L11',
      ok: quality === 'observed',
      quality,
      issueCount: summaryValid ? summary.error : null,
      warningCount: summaryValid ? summary.warning : null,
      filesScanned: integer(report?.filesScanned) ? report.filesScanned : null,
    },
  };
}

function numberOrNull(...values) {
  return values.find((value) => integer(value)) ?? null;
}

export function recordLoopEvidence({
  loopId,
  reportDir,
  registryPath = DEFAULT_REGISTRY_PATH,
  reportPath = null,
  now = new Date(),
} = {}) {
  if (!LOOP_ID_PATTERN.test(String(loopId || ''))) throw new Error('loopId must look like L0, L1, …');
  if (!reportDir) throw new Error('reportDir is required');
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const policy = findLoopPolicy(registry, loopId);
  const context = runContext(now);
  const prefix = String(loopId).toLowerCase();
  const resolvedReportPath = reportPath || path.join(dir, 'technical-operations-audit.json');

  let observation = readOptionalJson(path.join(dir, `${prefix}-observation.json`));
  let decision = readOptionalJson(path.join(dir, `${prefix}-decision.json`));
  let result = readOptionalJson(path.join(dir, `${prefix}-result.json`));
  if (loopId === 'L11' && (!observation || !decision)) {
    const technical = buildTechnicalAuditRecords({
      report: readJson(resolvedReportPath, 'technical operations report'),
      reportPath: resolvedReportPath,
      policy,
      now,
    });
    observation = technical.observation;
    decision = technical.decision;
    result = technical.result;
    fs.writeFileSync(path.join(dir, 'l11-observation.json'), `${JSON.stringify(observation, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'l11-decision.json'), `${JSON.stringify(decision, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'l11-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }

  const evidenceComplete = Boolean(observation && decision);
  let evidenceError = null;
  if (evidenceComplete) {
    try {
      validateRecord(observation, 'observation', loopId);
      validateRecord(decision, 'decision', loopId);
    } catch (error) {
      evidenceError = error.message;
    }
  } else {
    evidenceError = `missing ${prefix}-observation.json or ${prefix}-decision.json`;
  }

  const observed = evidenceComplete && !evidenceError ? withExecution(observation, 'observation', loopId, context) : null;
  const decided = evidenceComplete && !evidenceError ? withExecution(decision, 'decision', loopId, context) : null;
  const observationPolicy = observed ? policyCheck(registry, loopId, observed) : { ok: false, error: evidenceError };
  const decisionPolicy = decided ? policyCheck(registry, loopId, decided) : { ok: false, error: evidenceError };
  const decisionLifecycle = decided ? lifecycleCheck(registry, loopId, decided) : { ok: false, error: evidenceError };
  const policyErrors = [observationPolicy, decisionPolicy, decisionLifecycle]
    .filter((check) => !check.ok)
    .map((check) => check.error);
  const policyCompliant = policyErrors.length === 0;
  const quality = result?.quality || observed?.quality || 'unmeasurable';
  const actionClass = decided?.actionClass || observed?.actionClass || 'issue';
  const autonomy = (() => {
    try { return actionAutonomy(actionClass, registry.actionAutonomy); } catch { return null; }
  })();
  const health = {
    recordType: 'health',
    schemaVersion: 1,
    recordId: recordId('health', loopId, decided || observed || { recordedAt: now.toISOString() }, context),
    loopId,
    execution: context,
    recordedAt: now.toISOString(),
    quality,
    ok: Boolean(result?.ok ?? (quality === 'observed')) && evidenceComplete && policyCompliant,
    evidenceComplete,
    policyCompliant,
    lifecycleCompliant: decisionLifecycle.ok,
    lifecycle: policy.lifecycle,
    policyErrors,
    decision: decided?.decision || null,
    actionClass,
    requiredAutonomy: autonomy,
    maxAutonomy: policy.maxAutonomy,
    issueCount: numberOrNull(result?.issueCount),
    warningCount: numberOrNull(result?.warningCount),
    candidateCount: numberOrNull(result?.candidateCount),
    filesScanned: numberOrNull(result?.filesScanned),
    issued: result?.issued === true,
    actionsWritten: result?.actionsWritten === true,
    evidence: {
      observation: `${prefix}-observation.json`,
      decision: `${prefix}-decision.json`,
      result: `${prefix}-result.json`,
      report: fs.existsSync(path.resolve(resolvedReportPath)) ? relativePath(resolvedReportPath) : null,
    },
  };

  const ledgerDir = dir;
  const written = {
    observation: observed ? appendUnique(path.join(ledgerDir, 'loop-observations.jsonl'), observed) : false,
    decision: decided ? appendUnique(path.join(ledgerDir, 'loop-decisions.jsonl'), decided) : false,
    health: appendUnique(path.join(ledgerDir, 'loop-health-history.jsonl'), health),
  };
  const summary = {
    schemaVersion: 1,
    loopId,
    run: context,
    recordedAt: now.toISOString(),
    evidenceComplete,
    policyCompliant,
    quality,
    decision: health.decision,
    actionClass,
    requiredAutonomy: autonomy,
    maxAutonomy: policy.maxAutonomy,
    lifecycle: policy.lifecycle,
    lifecycleCompliant: decisionLifecycle.ok,
    ledgerFiles: ['loop-observations.jsonl', 'loop-decisions.jsonl', 'loop-health-history.jsonl'],
    written,
  };
  fs.writeFileSync(path.join(dir, 'loop-fleet-evidence.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, observation: observed, decision: decided, health, evidenceError, policyErrors };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = {
    loopId: valueAfter(argv, '--loop'),
    reportDir: valueAfter(argv, '--report-dir', process.env.REPORT_DIR),
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
    reportPath: valueAfter(argv, '--report'),
  };
  const result = recordLoopEvidence(options);
  logger.log(JSON.stringify(result.summary, null, 2));
  if (!result.summary.evidenceComplete || !result.summary.policyCompliant) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[loop-fleet-evidence] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
