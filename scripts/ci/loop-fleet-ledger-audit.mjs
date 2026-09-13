#!/usr/bin/env node

/**
 * Audit durable loop-fleet coverage and retention without mutating the fleet.
 *
 * The ledger bridge already validates a source artifact before opening a PR.
 * This report answers a different operational question: which loops have at
 * least one complete durable run, which lifecycle events are actually
 * present, and whether the configured/live artifact retention can be observed.
 * It only reads repository files and an optional read-only Actions API dump.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_LOOPS } from './loop-fleet-ledger-reconcile.mjs';
import {
  REQUIRED_LIFECYCLE_EVENT_TYPES,
  validateActionClassAgainstPolicy,
  validateDecisionLifecycle,
  validateLifecycleEvent,
  validateOutcomeAgainstPolicy,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

export const EXPECTED_RETENTION_DAYS = 90;
export const LEDGER_FILES = Object.freeze({
  observation: 'loop-observations.jsonl',
  decision: 'loop-decisions.jsonl',
  health: 'loop-health-history.jsonl',
  lifecycle: 'lifecycle-events.jsonl',
});
const BASE_LEDGER_TYPES = Object.freeze(['observation', 'decision', 'health']);
const RECORD_TYPES = Object.freeze({
  observation: 'observation',
  decision: 'decision',
  health: 'health',
  lifecycle: 'lifecycle-event',
});
const SHA_RE = /^[0-9a-f]{40}$/iu;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function iso(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid or unreadable: ${error.message}`);
  }
}

function readJsonl(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return { present: false, records: [], errors: [] };
  const records = [];
  const errors = [];
  for (const [index, line] of fs.readFileSync(absolute, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push({ line: index + 1, value: JSON.parse(line) });
    } catch (error) {
      errors.push(`${label} line ${index + 1}: invalid JSON (${error.message})`);
    }
  }
  return { present: true, records, errors };
}

function executionKey(record) {
  const runId = text(record?.execution?.runId);
  const sha = text(record?.execution?.sha)?.toLowerCase();
  return runId && sha ? `${runId}:${sha}` : null;
}

function recordTime(record) {
  return iso(record?.recordedAt || record?.occurredAt || record?.execution?.recordedAt);
}

function validateRecord(registry, type, record, line) {
  const errors = [];
  const expectedType = RECORD_TYPES[type];
  if (!object(record)) return [`${type} line ${line}: record is not an object`];
  if (record.recordType !== expectedType) errors.push(`${type} line ${line}: recordType is ${record.recordType || 'missing'}`);
  const loopId = text(record.loopId);
  const policy = loopId && registry.loops.find((loop) => loop.loopId === loopId);
  if (!policy) errors.push(`${type} line ${line}: loop ${loopId || 'missing'} is not declared in the registry`);
  if (!text(record.recordId)) errors.push(`${type} line ${line}: recordId is missing`);
  const execution = record.execution;
  if (!object(execution)) {
    errors.push(`${type} line ${line}: execution identity is missing`);
  } else {
    if (execution.loopId !== loopId) errors.push(`${type} line ${line}: execution loop does not match record loop`);
    if (!text(execution.runId)) errors.push(`${type} line ${line}: execution runId is missing`);
    if (!SHA_RE.test(String(execution.sha || ''))) errors.push(`${type} line ${line}: execution SHA is not a full commit SHA`);
  }
  if (!recordTime(record)) errors.push(`${type} line ${line}: recordedAt/occurredAt is not an ISO timestamp`);
  if (!policy || errors.length) return errors;

  try {
    if (type === 'lifecycle') {
      if (!record.recordedAt) errors.push(`${type} line ${line}: recordedAt is required`);
      validateLifecycleEvent(registry, loopId, record);
    } else {
      validateActionClassAgainstPolicy(registry, loopId, record.actionClass);
      if (type === 'decision') validateDecisionLifecycle(registry, loopId, record);
      validateOutcomeAgainstPolicy(registry, loopId, record.outcome);
    }
  } catch (error) {
    errors.push(`${type} line ${line}: registry validation failed (${error.message})`);
  }
  return errors;
}

function emptyLoop(loopId) {
  return {
    loopId,
    recordCounts: Object.fromEntries(Object.keys(LEDGER_FILES).map((type) => [type, 0])),
    validRecordCounts: Object.fromEntries(Object.keys(LEDGER_FILES).map((type) => [type, 0])),
    missingRecordTypes: [...BASE_LEDGER_TYPES],
    coverageState: 'missing',
    completeRunCount: 0,
    latestCompleteRun: null,
    latestRecordAt: null,
    independentOutcomeCount: 0,
    lifecycle: {
      eventCount: 0,
      candidateCount: 0,
      completeCandidateCount: 0,
      state: 'no_candidate',
      candidates: [],
    },
  };
}

function lifecycleSummary(events) {
  const byCandidate = new Map();
  for (const event of events) {
    const candidateId = text(event.candidateId);
    if (!candidateId) continue;
    if (!byCandidate.has(candidateId)) byCandidate.set(candidateId, []);
    byCandidate.get(candidateId).push(event);
  }
  const candidates = [...byCandidate.entries()].map(([candidateId, candidateEvents]) => {
    const eventTypes = [...new Set(candidateEvents.map((event) => event.eventType))];
    const missing = REQUIRED_LIFECYCLE_EVENT_TYPES.filter((eventType) => !eventTypes.includes(eventType));
    const last = [...candidateEvents]
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
      .at(-1);
    return {
      candidateId,
      owner: candidateEvents[0].owner,
      eventTypes,
      missing,
      complete: missing.length === 0,
      lastEvent: last ? { eventType: last.eventType, occurredAt: last.occurredAt } : null,
    };
  });
  return {
    eventCount: events.length,
    candidateCount: candidates.length,
    completeCandidateCount: candidates.filter((candidate) => candidate.complete).length,
    state: candidates.length === 0
      ? 'no_candidate'
      : (candidates.every((candidate) => candidate.complete) ? 'verified' : 'candidate'),
    candidates,
  };
}

/** Audit all four canonical files and group their base records by execution. */
export function auditLedger({ ledgerDir, registry, now = new Date() } = {}) {
  const validatedRegistry = validateLoopRegistry(registry);
  const rows = Object.fromEntries(validatedRegistry.loops.map((loop) => [loop.loopId, emptyLoop(loop.loopId)]));
  const runGroups = Object.fromEntries(validatedRegistry.loops.map((loop) => [loop.loopId, new Map()]));
  const lifecycleEvents = Object.fromEntries(validatedRegistry.loops.map((loop) => [loop.loopId, []]));
  const errors = [];
  const seenIds = Object.fromEntries(Object.keys(LEDGER_FILES).map((type) => [type, new Map()]));

  for (const [type, fileName] of Object.entries(LEDGER_FILES)) {
    const parsed = readJsonl(path.join(ledgerDir, fileName), `canonical ${fileName}`);
    errors.push(...parsed.errors);
    for (const { line, value: record } of parsed.records) {
      const loopId = text(record?.loopId);
      const row = rows[loopId];
      if (row) row.recordCounts[type] += 1;
      const recordId = text(record?.recordId);
      if (recordId) {
        const previous = seenIds[type].get(recordId);
        const serialized = JSON.stringify(record);
        if (previous) errors.push(`canonical ${fileName}: duplicate ${recordId} at line ${line}${previous.serialized === serialized ? '' : ' with conflicting content'}`);
        else seenIds[type].set(recordId, { serialized, line });
      }

      const recordErrors = validateRecord(validatedRegistry, type, record, line);
      errors.push(...recordErrors);
      if (recordErrors.length || !row) continue;
      row.validRecordCounts[type] += 1;
      const timestamp = recordTime(record);
      if (!row.latestRecordAt || Date.parse(timestamp) > Date.parse(row.latestRecordAt)) row.latestRecordAt = timestamp;
      if (type === 'lifecycle') {
        lifecycleEvents[loopId].push(record);
        continue;
      }
      const key = executionKey(record);
      if (!key) continue;
      if (!runGroups[loopId].has(key)) {
        runGroups[loopId].set(key, {
          runId: String(record.execution.runId),
          sha: String(record.execution.sha).toLowerCase(),
          types: new Set(),
          recordedAt: timestamp,
        });
      }
      const group = runGroups[loopId].get(key);
      group.types.add(type);
      if (timestamp && (!group.recordedAt || Date.parse(timestamp) > Date.parse(group.recordedAt))) group.recordedAt = timestamp;
      if (type === 'health' && record.outcome?.independent === true
          && ['observed', 'zero'].includes(record.outcome.status)
          && Array.isArray(record.outcome.missingFields) && record.outcome.missingFields.length === 0) {
        row.independentOutcomeCount += 1;
      }
    }
  }

  for (const loop of validatedRegistry.loops) {
    const row = rows[loop.loopId];
    const groups = [...runGroups[loop.loopId].values()];
    const completeRuns = groups.filter((group) => BASE_LEDGER_TYPES.every((type) => group.types.has(type)));
    row.missingRecordTypes = BASE_LEDGER_TYPES.filter((type) => row.validRecordCounts[type] === 0);
    row.completeRunCount = completeRuns.length;
    row.coverageState = completeRuns.length ? 'complete' : (groups.length ? 'partial' : 'missing');
    const latest = [...completeRuns].sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt)).at(-1);
    row.latestCompleteRun = latest
      ? { runId: latest.runId, sha: latest.sha, recordedAt: latest.recordedAt }
      : null;
    row.lifecycle = lifecycleSummary(lifecycleEvents[loop.loopId]);
  }

  const loopRows = Object.values(rows);
  const completeLoopCount = loopRows.filter((row) => row.coverageState === 'complete').length;
  const independentOutcomeLoopCount = loopRows.filter((row) => row.independentOutcomeCount > 0).length;
  const status = errors.length
    ? 'error'
    : (completeLoopCount === validatedRegistry.loops.length ? 'observed' : (completeLoopCount ? 'partial' : 'unmeasurable'));
  return {
    ledgerDir: path.resolve(ledgerDir),
    generatedAt: now.toISOString(),
    loops: loopRows,
    errors,
    summary: {
      status,
      loopCount: validatedRegistry.loops.length,
      completeLoopCount,
      coverageRate: completeLoopCount / validatedRegistry.loops.length,
      independentOutcomeLoopCount,
      lifecycleCandidateCount: loopRows.reduce((sum, row) => sum + row.lifecycle.candidateCount, 0),
      lifecycleCompleteCandidateCount: loopRows.reduce((sum, row) => sum + row.lifecycle.completeCandidateCount, 0),
      totalRecords: loopRows.reduce((sum, row) => sum + Object.values(row.recordCounts).reduce((inner, count) => inner + count, 0), 0),
    },
  };
}

function sourceWorkflowRows({ workflowDir, sourceLoops, expectedRetentionDays }) {
  return sourceLoops.map((definition) => {
    const file = path.resolve(workflowDir, definition.workflowFile);
    const issues = [];
    if (!fs.existsSync(file)) {
      return {
        ...definition,
        workflowFile: definition.workflowFile,
        exists: false,
        retentionDays: [],
        uploadsEvidence: false,
        uploadsLifecycle: false,
        artifactNaming: false,
        status: 'missing',
        issues: ['workflow file is missing'],
      };
    }
    const source = fs.readFileSync(file, 'utf8');
    const retentionDays = [...source.matchAll(/\bretention-days:\s*(\d+)/gu)].map((match) => Number(match[1]));
    const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
    const uploadsEvidence = uploadsWholeDirectory || source.includes('loop-fleet-evidence.json');
    const uploadsLifecycle = uploadsWholeDirectory || source.includes('lifecycle-events.jsonl');
    const artifactNaming = source.includes(`${definition.artifactPrefix}-`) && /\$\{\{\s*github\.run_id\s*\}\}/u.test(source);
    if (!retentionDays.length) issues.push('artifact retention-days is missing');
    if (retentionDays.some((days) => days !== expectedRetentionDays)) issues.push(`retention-days is not uniformly ${expectedRetentionDays}`);
    if (!uploadsEvidence) issues.push('canonical loop-fleet-evidence.json is not uploaded');
    if (!uploadsLifecycle) issues.push('lifecycle-events.jsonl is not uploaded');
    if (!artifactNaming) issues.push('artifact name/run identity is not recognizable');
    return {
      ...definition,
      workflowFile: definition.workflowFile,
      exists: true,
      retentionDays,
      uploadsEvidence,
      uploadsLifecycle,
      artifactNaming,
      status: issues.length ? 'incomplete' : 'ok',
      issues,
    };
  });
}

/** Check the static 90-day contract and canonical files for every source loop. */
export function auditWorkflowRetention({ workflowDir, sourceLoops = SOURCE_LOOPS, expectedRetentionDays = EXPECTED_RETENTION_DAYS } = {}) {
  const rows = sourceWorkflowRows({ workflowDir, sourceLoops, expectedRetentionDays });
  const compliantCount = rows.filter((row) => row.status === 'ok').length;
  return {
    workflowDir: path.resolve(workflowDir),
    expectedRetentionDays,
    loops: rows,
    errors: rows.flatMap((row) => row.issues.map((issue) => `${row.loopId}: ${issue}`)),
    summary: {
      status: compliantCount === rows.length ? 'observed' : (compliantCount ? 'partial' : 'unmeasurable'),
      loopCount: rows.length,
      compliantCount,
      noncompliantCount: rows.length - compliantCount,
    },
  };
}

function flattenArtifactPayload(payload) {
  if (payload && payload.available === false) return { available: false, artifacts: [], error: text(payload.error) || 'artifact metadata is unavailable' };
  const pages = Array.isArray(payload) ? payload : [payload];
  const artifacts = [];
  let declaredTotal = null;
  for (const page of pages) {
    if (Array.isArray(page)) {
      artifacts.push(...page);
      continue;
    }
    if (!object(page)) continue;
    if (Number.isSafeInteger(page.total_count)) declaredTotal = Math.max(declaredTotal ?? 0, page.total_count);
    if (Array.isArray(page.artifacts)) artifacts.push(...page.artifacts);
  }
  if (!artifacts.length && pages.some((page) => object(page) && !Array.isArray(page.artifacts) && !Number.isSafeInteger(page.total_count))) {
    return { available: false, artifacts: [], error: 'artifact metadata payload has no recognized artifacts list' };
  }
  return { available: true, artifacts, declaredTotal, error: null };
}

function artifactRetentionDays(artifact) {
  const createdAt = Date.parse(artifact?.created_at || '');
  const expiresAt = Date.parse(artifact?.expires_at || '');
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  return (expiresAt - createdAt) / 86_400_000;
}

/** Inspect read-only Actions artifact metadata; no artifact is deleted or changed. */
export function auditArtifactRetention({ payload, sourceLoops = SOURCE_LOOPS, expectedRetentionDays = EXPECTED_RETENTION_DAYS, now = new Date() } = {}) {
  const normalized = flattenArtifactPayload(payload);
  if (!normalized.available) {
    return {
      available: false,
      expectedRetentionDays,
      loops: sourceLoops.map((definition) => ({ ...definition, status: 'unmeasurable', artifactCount: 0, activeCount: 0, expiredCount: 0, issues: [normalized.error] })),
      errors: [],
      summary: {
        status: 'unmeasurable',
        artifactCount: 0,
        measuredLoopCount: 0,
        compliantLoopCount: 0,
        declaredTotal: null,
        listedTotal: 0,
        apiComplete: false,
        reason: normalized.error,
      },
    };
  }
  const errors = [];
  const rows = sourceLoops.map((definition) => {
    const prefix = `${definition.artifactPrefix}-`;
    const scoped = normalized.artifacts.filter((artifact) => typeof artifact?.name === 'string' && artifact.name.startsWith(prefix));
    const malformed = scoped.filter((artifact) => !/^\d+$/u.test(artifact.name.slice(prefix.length)));
    const issues = malformed.map((artifact) => `artifact name ${artifact.name} has no numeric run suffix`);
    const retentionValues = scoped.map(artifactRetentionDays);
    const missingDates = retentionValues.filter((value) => value === null).length;
    if (missingDates) issues.push(`${missingDates} artifact(s) have no created_at/expires_at pair`);
    const validRetentionValues = retentionValues.filter((value) => value !== null);
    if (validRetentionValues.some((value) => Math.abs(value - expectedRetentionDays) > 0.1)) {
      issues.push(`observed retention is not uniformly ${expectedRetentionDays} days`);
    }
    const activeCount = scoped.filter((artifact) => artifact.expired !== true && Date.parse(artifact.expires_at || '') > now.getTime()).length;
    const expiredCount = scoped.length - activeCount;
    const latest = [...scoped].sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || '')).at(0);
    const status = scoped.length === 0 ? 'unmeasurable' : (issues.length ? 'partial' : 'observed');
    return {
      ...definition,
      status,
      artifactCount: scoped.length,
      activeCount,
      expiredCount,
      retentionDays: validRetentionValues.length ? {
        min: Math.min(...validRetentionValues),
        max: Math.max(...validRetentionValues),
      } : null,
      latestArtifact: latest ? {
        name: latest.name,
        createdAt: iso(latest.created_at),
        expiresAt: iso(latest.expires_at),
      } : null,
      issues,
    };
  });
  const apiComplete = normalized.declaredTotal === null || normalized.artifacts.length >= normalized.declaredTotal;
  if (!apiComplete) errors.push(`Actions artifact metadata is truncated: listed ${normalized.artifacts.length} of ${normalized.declaredTotal}`);
  const measuredLoopCount = rows.filter((row) => row.status === 'observed').length;
  const compliantLoopCount = rows.filter((row) => row.status === 'observed' && row.artifactCount > 0).length;
  return {
    available: true,
    expectedRetentionDays,
    loops: rows,
    errors,
    summary: {
      status: errors.length ? 'partial' : (measuredLoopCount === rows.length ? 'observed' : (measuredLoopCount ? 'partial' : 'unmeasurable')),
      artifactCount: normalized.artifacts.length,
      measuredLoopCount,
      compliantLoopCount,
      declaredTotal: normalized.declaredTotal,
      listedTotal: normalized.artifacts.length,
      apiComplete,
    },
  };
}

export function auditLoopFleet({ registryPath, ledgerDir, workflowDir, artifactsPath = null, now = new Date() } = {}) {
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  let artifactPayload = { available: false, error: 'artifact metadata file was not supplied' };
  if (artifactsPath) {
    try {
      artifactPayload = readJson(artifactsPath, 'artifact metadata');
    } catch (error) {
      artifactPayload = { available: false, error: error.message };
    }
  }
  const ledger = auditLedger({ ledgerDir, registry, now });
  const workflows = auditWorkflowRetention({ workflowDir });
  const artifacts = auditArtifactRetention({ payload: artifactPayload, now });
  const errors = [...ledger.errors, ...workflows.errors, ...artifacts.errors];
  const fullyObserved = ledger.summary.status === 'observed'
    && workflows.summary.status === 'observed'
    && artifacts.summary.status === 'observed';
  const hasMeasuredData = ledger.summary.totalRecords > 0 || artifacts.available;
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repository: text(process.env.GITHUB_REPOSITORY),
    quality: errors.length ? 'error' : (fullyObserved ? 'observed' : (hasMeasuredData ? 'partial' : 'unmeasurable')),
    errors,
    ledger,
    workflows,
    artifacts,
    summary: {
      quality: errors.length ? 'error' : (fullyObserved ? 'observed' : (hasMeasuredData ? 'partial' : 'unmeasurable')),
      errorCount: errors.length,
      loopCount: registry.loops.length,
      ledgerCoverageRate: ledger.summary.coverageRate,
      configuredRetentionCompliant: workflows.summary.compliantCount === workflows.summary.loopCount,
      liveRetentionMeasured: artifacts.summary.measuredLoopCount === artifacts.loops.length,
      independentOutcomeLoopCount: ledger.summary.independentOutcomeLoopCount,
    },
  };
}

export function renderMarkdown(report) {
  const lines = [
    '## Loop fleet ledger audit',
    '',
    `- Qualità: **${report.quality}**`,
    `- Copertura ledger completa: ${report.ledger.summary.completeLoopCount}/${report.ledger.summary.loopCount} loop (${(report.ledger.summary.coverageRate * 100).toFixed(1)}%)`,
    `- Outcome indipendente osservato nel ledger: ${report.ledger.summary.independentOutcomeLoopCount}/${report.ledger.summary.loopCount} loop`,
    `- Retention configurata conforme: ${report.workflows.summary.compliantCount}/${report.workflows.summary.loopCount} loop`,
    `- Retention live misurata: ${report.artifacts.summary.measuredLoopCount}/${report.artifacts.loops.length} loop`,
    '',
    '| Loop | Ledger | Run completi | Ultimo run completo | Lifecycle | Outcome indipendente | Retention configurata | Retention live |',
    '| --- | --- | ---: | --- | --- | ---: | --- | --- |',
  ];
  const artifactByLoop = new Map(report.artifacts.loops.map((row) => [row.loopId, row]));
  const workflowByLoop = new Map(report.workflows.loops.map((row) => [row.loopId, row]));
  for (const row of report.ledger.loops) {
    const artifact = artifactByLoop.get(row.loopId);
    const workflow = workflowByLoop.get(row.loopId);
    const latest = row.latestCompleteRun ? `${row.latestCompleteRun.runId} @ ${row.latestCompleteRun.recordedAt}` : 'n/d';
    lines.push(`| ${row.loopId} | ${row.coverageState} | ${row.completeRunCount} | ${latest} | ${row.lifecycle.state} (${row.lifecycle.eventCount}) | ${row.independentOutcomeCount} | ${workflow?.status || 'n/d'} | ${artifact?.status || 'unmeasurable'} (${artifact?.artifactCount || 0}) |`);
  }
  if (report.errors.length) {
    lines.push('', '### Errori strutturali', '', ...report.errors.map((error) => `- ${error}`));
  }
  if (report.artifacts.summary.reason) lines.push('', `Metadata Actions: ${report.artifacts.summary.reason}.`);
  lines.push('', 'Questo audit è read-only: non elimina artifact, non apre PR e non modifica dati o superfici pubblicate.');
  return `${lines.join('\n')}\n`;
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outDir = path.resolve(valueAfter(argv, '--out-dir', process.env.REPORT_DIR || process.env.RUNNER_TEMP || 'audit-report'));
  fs.mkdirSync(outDir, { recursive: true });
  const report = auditLoopFleet({
    registryPath: valueAfter(argv, '--registry', path.join('data', 'loop-fleet', 'loop-registry.json')),
    ledgerDir: valueAfter(argv, '--ledger-dir', path.join('data', 'loop-fleet', 'ledger')),
    workflowDir: valueAfter(argv, '--workflow-dir', path.join('.github', 'workflows')),
    artifactsPath: valueAfter(argv, '--artifacts'),
  });
  fs.writeFileSync(path.join(outDir, 'loop-fleet-ledger-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'loop-fleet-ledger-audit.md'), renderMarkdown(report));
  logger.log(renderMarkdown(report));
  if (argv.includes('--strict') && report.quality !== 'observed') process.exitCode = 2;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-ledger-audit] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
