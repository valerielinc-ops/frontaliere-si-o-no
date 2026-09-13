#!/usr/bin/env node

/**
 * Merge one immutable loop-run artifact into the durable fleet ledger.
 *
 * This helper only appends validated records. It has no GitHub or production
 * credentials; the caller owns the reviewed branch/PR that carries the four
 * JSONL files. A rerun is idempotent by recordId and a conflicting duplicate
 * fails closed instead of silently rewriting history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendJsonlSerialized,
  validateActionClassAgainstPolicy,
  validateDecisionLifecycle,
  validateLifecycleEvent,
  validateOutcomeAgainstPolicy,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const LEDGER_FILES = Object.freeze({
  observation: 'loop-observations.jsonl',
  decision: 'loop-decisions.jsonl',
  health: 'loop-health-history.jsonl',
  lifecycle: 'lifecycle-events.jsonl',
});

const RECORD_TYPES = Object.freeze({
  observation: 'observation',
  decision: 'decision',
  health: 'health',
  lifecycle: 'lifecycle-event',
});

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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

function findFiles(root, name) {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return path.basename(absolute) === name ? [absolute] : [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => findFiles(path.join(absolute, entry.name), name));
}

function findSingleFile(root, name, { required = true } = {}) {
  const files = findFiles(root, name);
  if (!files.length) {
    if (required) throw new Error(`${name} is missing from input artifact ${root}`);
    return null;
  }
  if (files.length > 1) throw new Error(`${name} occurs more than once in input artifact ${root}`);
  return files[0];
}

function readJsonl(file, label, { required = false } = {}) {
  if (!fs.existsSync(path.resolve(file))) {
    if (required) throw new Error(`${label} is missing: ${file}`);
    return [];
  }
  const lines = fs.readFileSync(path.resolve(file), 'utf8').split('\n').filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

function assertExecution(record, expected) {
  const execution = record.execution;
  if (!object(execution)) throw new Error(`${record.recordType} ${record.recordId || 'unknown'} has no execution identity`);
  if (String(execution.loopId || '') !== String(expected.loopId)) {
    throw new Error(`${record.recordType} ${record.recordId || 'unknown'} belongs to execution loop ${execution.loopId || 'unknown'}, expected ${expected.loopId}`);
  }
  if (String(execution.runId || '') !== String(expected.runId)) {
    throw new Error(`${record.recordType} ${record.recordId || 'unknown'} belongs to run ${execution.runId || 'unknown'}, expected ${expected.runId}`);
  }
  if (String(execution.sha || '').toLowerCase() !== expected.sha) {
    throw new Error(`${record.recordType} ${record.recordId || 'unknown'} has SHA ${execution.sha || 'unknown'}, expected ${expected.sha}`);
  }
}

function validateRecord(registry, loopId, type, record, expected) {
  if (!object(record)) throw new Error(`${type} record is not an object`);
  const recordType = RECORD_TYPES[type] || type;
  if (record.recordType !== recordType) throw new Error(`${type} recordType is ${record.recordType || 'missing'}`);
  if (record.loopId !== loopId) throw new Error(`${type} record belongs to ${record.loopId || 'unknown'}, expected ${loopId}`);
  if (!text(record.recordId)) throw new Error(`${type} record has no recordId`);
  assertExecution(record, expected);
  try {
    if (type === 'lifecycle') {
      validateLifecycleEvent(registry, loopId, record);
      return record;
    }
    validateActionClassAgainstPolicy(registry, loopId, record.actionClass);
    if (type === 'decision') validateDecisionLifecycle(registry, loopId, record);
    validateOutcomeAgainstPolicy(registry, loopId, record.outcome);
  } catch (error) {
    throw new Error(`${type} ${record.recordId} violates the registry: ${error.message}`);
  }
  return record;
}

function validateHistoricalRecord(registry, type, record) {
  if (!object(record)) throw new Error(`${type} historical record is not an object`);
  const recordType = RECORD_TYPES[type] || type;
  if (record.recordType !== recordType) throw new Error(`historical ${type} recordType is ${record.recordType || 'missing'}`);
  const historicalLoopId = text(record.loopId);
  if (!historicalLoopId || !registry.loops.some((loop) => loop.loopId === historicalLoopId)) {
    throw new Error(`historical ${type} record belongs to ${record.loopId || 'unknown'}, which is not declared in the registry`);
  }
  if (!text(record.recordId)) throw new Error(`historical ${type} record has no recordId`);
  if (!object(record.execution) || record.execution.loopId !== historicalLoopId || !text(record.execution.runId) || !/^[0-9a-f]{40}$/iu.test(String(record.execution.sha || ''))) {
    throw new Error(`historical ${type} ${record.recordId} has no durable execution identity`);
  }
  try {
    if (type === 'lifecycle') {
      validateLifecycleEvent(registry, historicalLoopId, record);
      return record;
    }
    validateActionClassAgainstPolicy(registry, historicalLoopId, record.actionClass);
    if (type === 'decision') validateDecisionLifecycle(registry, historicalLoopId, record);
    validateOutcomeAgainstPolicy(registry, historicalLoopId, record.outcome);
  } catch (error) {
    throw new Error(`historical ${type} ${record.recordId} violates the registry: ${error.message}`);
  }
  return record;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeRecords({ target, label, records, registry, loopId, type }) {
  const existing = readJsonl(target, label);
  const byId = new Map();
  for (const record of existing) {
    validateHistoricalRecord(registry, type, record);
    if (!text(record.recordId)) throw new Error(`${label} contains a record without recordId`);
    if (byId.has(record.recordId) && !sameRecord(byId.get(record.recordId), record)) {
      throw new Error(`${label} contains conflicting duplicate ${record.recordId}`);
    }
    byId.set(record.recordId, record);
  }
  let appended = 0;
  let skipped = 0;
  for (const record of records) {
    const previous = byId.get(record.recordId);
    if (previous) {
      if (!sameRecord(previous, record)) throw new Error(`${label} has conflicting duplicate ${record.recordId}`);
      skipped += 1;
      continue;
    }
    const write = appendJsonlSerialized(target, record, { label });
    byId.set(record.recordId, record);
    if (write.appended) appended += 1;
    else skipped += 1;
  }
  return { appended, skipped, existing: existing.length };
}

export function mergeLoopFleetLedger({
  loopId,
  runId,
  sha,
  inputDir,
  ledgerDir,
  registryPath = DEFAULT_REGISTRY_PATH,
} = {}) {
  if (!/^L\d+$/u.test(String(loopId || ''))) throw new Error('loopId must look like L0, L1, …');
  if (!text(runId)) throw new Error('runId is required');
  if (!/^[0-9a-f]{40}$/iu.test(String(sha || ''))) throw new Error('sha must be a 40-character commit SHA');
  if (!inputDir) throw new Error('inputDir is required');
  if (!ledgerDir) throw new Error('ledgerDir is required');
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const policy = registry.loops.find((loop) => loop.loopId === loopId);
  if (!policy) throw new Error(`registry has no policy for ${loopId}`);
  const expected = { loopId, runId: String(runId), sha: String(sha).toLowerCase() };
  const summaryFile = findSingleFile(inputDir, 'loop-fleet-evidence.json');
  const summary = readJson(summaryFile, 'loop-fleet-evidence.json');
  if (summary.loopId !== loopId) throw new Error(`evidence summary belongs to ${summary.loopId || 'unknown'}, expected ${loopId}`);
  if (String(summary.run?.runId || '') !== expected.runId) throw new Error('evidence summary runId does not match the source run');
  if (String(summary.run?.sha || '').toLowerCase() !== expected.sha) throw new Error('evidence summary SHA does not match the source run');
  if (summary.outcome?.outcomeId !== policy.outcome.outcomeId) throw new Error('evidence summary outcome contract does not match the registry');

  const records = {};
  for (const [type, fileName] of Object.entries(LEDGER_FILES)) {
    // Lifecycle events were introduced after the first durable artifacts.
    // New recorder artifacts include them; old artifacts remain mergeable so
    // reconciliation can recover their observations without inventing events.
    const sourceFile = findSingleFile(inputDir, fileName, { required: type === 'health' });
    records[type] = sourceFile
      ? readJsonl(sourceFile, `${fileName} input`).map((record) => validateRecord(registry, loopId, type, record, expected))
      : [];
  }
  if (!records.health.length) throw new Error('input artifact has no health records');

  const targetDir = path.resolve(ledgerDir);
  const results = {};
  for (const [type, fileName] of Object.entries(LEDGER_FILES)) {
    results[type] = mergeRecords({
      target: path.join(targetDir, fileName),
      label: `canonical ${fileName}`,
      records: records[type],
      registry,
      loopId,
      type,
    });
  }
  return {
    loopId,
    runId: expected.runId,
    sha: expected.sha,
    inputRecords: Object.fromEntries(Object.entries(records).map(([type, values]) => [type, values.length])),
    results,
    ledgerDir: targetDir,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = mergeLoopFleetLedger({
    loopId: valueAfter(argv, '--loop'),
    runId: valueAfter(argv, '--run-id'),
    sha: valueAfter(argv, '--sha'),
    inputDir: valueAfter(argv, '--input-dir'),
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
    console.error(`[loop-fleet-ledger] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
