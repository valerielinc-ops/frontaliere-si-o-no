#!/usr/bin/env node

/**
 * Reconcile completed loop runs with the durable ledger bridge.
 *
 * The normal bridge is event-driven (`workflow_run`). GitHub can lose or delay
 * that event, so this bounded, read-only probe looks back over recent eligible
 * main runs, downloads their immutable evidence and dispatches the existing
 * reviewed bridge only when a record is absent from the current ledger.
 *
 * This helper never edits a branch, opens a PR or touches published data. A
 * bridge dispatch is only a request to run the already fail-closed
 * `loop-fleet-ledger.yml`; its own reviewed App/PAT and PR gates remain the
 * mutation boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SOURCE_LOOPS = Object.freeze([
  ['L0', 'loop-l0-data-truth.yml', 'loop-l0-data-truth'],
  ['L1', 'loop-l1-reliability.yml', 'loop-l1-reliability'],
  ['L2', 'loop-l2-demand-utility.yml', 'loop-l2-demand-utility'],
  ['L3', 'loop-l3-job-quality.yml', 'loop-l3-job-quality'],
  ['L4', 'loop-l4-alert-return.yml', 'loop-l4-alert-return'],
  ['L5', 'loop-l5-decision-moments.yml', 'loop-l5-decision-moments'],
  ['L6', 'loop-l6-content-factuality.yml', 'loop-l6-content-factuality'],
  ['L7', 'loop-l7-experiment-allocator.yml', 'loop-l7-experiment-allocator'],
  ['L8', 'loop-l8-revenue-attribution.yml', 'loop-l8-revenue-attribution'],
  ['L9', 'loop-l9-employer-activation.yml', 'loop-l9-employer-activation'],
  ['L10', 'loop-l10-fleet-control.yml', 'loop-l10-fleet-control'],
  ['L11', 'technical-operations-supervisor.yml', 'technical-operations-audit'],
].map(([loopId, workflowFile, artifactPrefix]) => Object.freeze({ loopId, workflowFile, artifactPrefix })));

const RUN_SHA_RE = /^[0-9a-f]{40}$/iu;

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJson(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function repo() {
  return process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
}

function gh(args, { allowFailure = false } = {}) {
  const fullArgs = [...args, ...(repo() ? ['--repo', repo()] : [])];
  try {
    return execFileSync('gh', fullArgs, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

export function sourceDefinition(loopId) {
  return SOURCE_LOOPS.find((definition) => definition.loopId === String(loopId)) || null;
}

export function sourceArtifactName(loopId, runId) {
  const definition = sourceDefinition(loopId);
  if (!definition || !/^\d+$/u.test(String(runId || ''))) return null;
  return `${definition.artifactPrefix}-${runId}`;
}

/** A source run is eligible only when it is an immutable completed main run. */
export function eligibleSourceRun(run, definition) {
  return Boolean(definition
    && run
    && String(run.status || '') === 'completed'
    && String(run.headBranch || '') === 'main'
    && String(run.event || '') !== 'pull_request'
    && String(run.conclusion || '') !== 'cancelled'
    && /^\d+$/u.test(String(run.databaseId || run.id || ''))
    && RUN_SHA_RE.test(String(run.headSha || '')));
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return null;
  const stat = fs.statSync(root);
  if (stat.isFile()) return path.basename(root) === name ? root : null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = findFile(candidate, name);
      if (found) return found;
    }
  }
  return null;
}

function jsonlRecords(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordIds(ledgerDir, fileName) {
  const file = path.join(path.resolve(ledgerDir), fileName);
  return new Set(jsonlRecords(file).map((record) => String(record?.recordId || '')).filter(Boolean));
}

export function durableRecordIds(ledgerDir) {
  return {
    observation: recordIds(ledgerDir, 'loop-observations.jsonl'),
    decision: recordIds(ledgerDir, 'loop-decisions.jsonl'),
    health: recordIds(ledgerDir, 'loop-health-history.jsonl'),
    lifecycle: recordIds(ledgerDir, 'lifecycle-events.jsonl'),
  };
}

/**
 * Return the evidence IDs that are not in the durable ledger. Malformed or
 * incomplete artifacts are reported as unavailable, never as already saved.
 */
export function missingEvidenceRecordIds(inputDir, ledgerDir, { loopId, runId, sha } = {}) {
  const summaryFile = findFile(inputDir, 'loop-fleet-evidence.json');
  if (!summaryFile) return { ok: false, reason: 'loop-fleet-evidence.json is missing', missing: [] };
  const summary = parseJson(fs.readFileSync(summaryFile, 'utf8'));
  if (!summary || summary.loopId !== loopId
      || String(summary.run?.runId || '') !== String(runId)
      || String(summary.run?.sha || '').toLowerCase() !== String(sha || '').toLowerCase()) {
    return { ok: false, reason: 'evidence summary provenance does not match the source run', missing: [] };
  }

  const durable = durableRecordIds(ledgerDir);
  const records = {};
  for (const [type, fileName] of Object.entries({
    observation: 'loop-observations.jsonl',
    decision: 'loop-decisions.jsonl',
    health: 'loop-health-history.jsonl',
    lifecycle: 'lifecycle-events.jsonl',
  })) {
    const file = findFile(inputDir, fileName);
    records[type] = file ? jsonlRecords(file) : [];
  }
  if (records.health.length === 0) return { ok: false, reason: 'health evidence is missing', missing: [] };

  const missing = [];
  for (const [type, values] of Object.entries(records)) {
    for (const record of values) {
      if (!record?.recordId || record.loopId !== loopId || record.execution?.loopId !== loopId
          || String(record.execution?.runId || '') !== String(runId)
          || String(record.execution?.sha || '').toLowerCase() !== String(sha || '').toLowerCase()) {
        return { ok: false, reason: `${type} evidence has invalid execution identity`, missing: [] };
      }
      if (!durable[type].has(record.recordId)) missing.push({ type, recordId: record.recordId });
    }
  }
  return { ok: true, reason: missing.length ? 'durable ledger is missing one or more source records' : 'source run is already durable', missing };
}

export function selectRecoveryCandidates(candidates, { maxDispatches = 3 } = {}) {
  const cap = positiveInt(maxDispatches, 3);
  return [...(candidates || [])]
    .filter((candidate) => candidate && eligibleSourceRun(candidate.run, candidate.definition))
    .sort((left, right) => {
      const leftTime = Date.parse(left.run.createdAt || '') || 0;
      const rightTime = Date.parse(right.run.createdAt || '') || 0;
      return leftTime - rightTime
        || Number(left.run.databaseId || left.run.id) - Number(right.run.databaseId || right.run.id)
        || left.definition.loopId.localeCompare(right.definition.loopId);
    })
    .slice(0, cap);
}

export function hasActiveBridgeRun(runs) {
  return (runs || []).some((run) => new Set(['queued', 'in_progress', 'pending', 'requested'])
    .has(String(run?.status || '')));
}

function runList(definition, limit) {
  const raw = gh([
    'run', 'list', '--workflow', definition.workflowFile, '--branch', 'main',
    '--status', 'completed', '--limit', String(limit),
    '--json', 'databaseId,status,conclusion,headBranch,headSha,event,createdAt,updatedAt',
  ], { allowFailure: true });
  const runs = parseJson(raw, []);
  return Array.isArray(runs) ? runs : [];
}

function downloadEvidence(definition, run, root) {
  const runId = String(run.databaseId || run.id || '');
  const target = path.join(root, `${definition.loopId.toLowerCase()}-${runId}`);
  fs.mkdirSync(target, { recursive: true });
  const artifact = sourceArtifactName(definition.loopId, runId);
  if (!artifact) return { ok: false, reason: 'source artifact name is invalid', target };
  const downloaded = gh(['run', 'download', runId, '--name', artifact, '--dir', target], { allowFailure: true });
  void downloaded;
  const inputDir = findFile(target, 'loop-fleet-evidence.json') ? target : null;
  if (!inputDir) return { ok: false, reason: 'immutable source artifact is unavailable', target };
  return { ok: true, inputDir, target };
}

function dispatchBridge(candidate) {
  const runId = String(candidate.run.databaseId || candidate.run.id || '');
  const args = [
    'workflow', 'run', 'loop-fleet-ledger.yml', '--ref', 'main',
    '-f', `loop=${candidate.definition.loopId}`,
    '-f', `run_id=${runId}`,
    '-f', `sha=${String(candidate.run.headSha).toLowerCase()}`,
  ];
  return Boolean(gh(args, { allowFailure: true }));
}

function activeBridgeRun() {
  const raw = gh([
    'run', 'list', '--workflow', 'loop-fleet-ledger.yml', '--limit', '20', '--json', 'status,databaseId',
  ], { allowFailure: true });
  const runs = parseJson(raw, []);
  return Array.isArray(runs) && hasActiveBridgeRun(runs);
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function reconcileLoopFleetLedger({
  ledgerDir = path.join('data', 'loop-fleet', 'ledger'),
  maxRunsPerLoop = positiveInt(process.env.LOOP_FLEET_RECONCILE_MAX_RUNS, 12),
  maxDispatches = positiveInt(process.env.LOOP_FLEET_RECONCILE_MAX_DISPATCHES, 3),
  dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-reconcile-')),
  log = console,
} = {}) {
  const candidates = [];
  const scanned = [];
  for (const definition of SOURCE_LOOPS) {
    for (const run of runList(definition, positiveInt(maxRunsPerLoop, 12))) {
      if (!eligibleSourceRun(run, definition)) continue;
      const runId = String(run.databaseId || run.id || '');
      const download = downloadEvidence(definition, run, tempRoot);
      const result = download.ok
        ? missingEvidenceRecordIds(download.inputDir, ledgerDir, {
          loopId: definition.loopId,
          runId,
          sha: run.headSha,
        })
        : { ok: false, reason: download.reason, missing: [] };
      scanned.push({ loopId: definition.loopId, runId, reason: result.reason, missing: result.missing.length });
      if (result.ok && result.missing.length) candidates.push({ definition, run, missing: result.missing });
    }
  }

  const selected = selectRecoveryCandidates(candidates, { maxDispatches });
  const bridgeActive = activeBridgeRun();
  if (bridgeActive) log.log('loop-fleet-ledger-reconcile: bridge già in coda o in esecuzione; nessun dispatch duplicato.');
  const dispatched = [];
  for (const candidate of selected) {
    const runId = String(candidate.run.databaseId || candidate.run.id || '');
    if (dryRun) {
      log.log(`[dry-run] bridge richiesto per ${candidate.definition.loopId} run ${runId}`);
      continue;
    }
    if (bridgeActive) continue;
    if (dispatchBridge(candidate)) dispatched.push({ loopId: candidate.definition.loopId, runId });
    else log.log(`::warning::bridge dispatch fallito per ${candidate.definition.loopId} run ${runId}; il prossimo tick riprova.`);
  }
  return {
    schemaVersion: 1,
    repository: repo() || null,
    dryRun,
    limits: { maxRunsPerLoop, maxDispatches },
    scanned,
    candidates: selected.map((candidate) => ({
      loopId: candidate.definition.loopId,
      runId: String(candidate.run.databaseId || candidate.run.id || ''),
      missingRecords: candidate.missing,
    })),
    bridgeActive,
    dispatched,
    tempRoot,
  };
}

function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = reconcileLoopFleetLedger({
    ledgerDir: valueAfter(argv, '--ledger-dir', path.join('data', 'loop-fleet', 'ledger')),
    maxRunsPerLoop: Number(valueAfter(argv, '--max-runs', process.env.LOOP_FLEET_RECONCILE_MAX_RUNS || 12)),
    maxDispatches: Number(valueAfter(argv, '--max-dispatches', process.env.LOOP_FLEET_RECONCILE_MAX_DISPATCHES || 3)),
    dryRun: argv.includes('--dry-run') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',
  });
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-ledger-reconcile] probe fallita: ${error.message}`);
    process.exitCode = 1;
  }
}
