#!/usr/bin/env node

/**
 * Collect the read-only GitHub Actions side of the L10 oracle.
 *
 * The command deliberately returns an explicit partial/unmeasurable artifact
 * when GitHub or the health ledger is unavailable. It never writes GitHub,
 * source data, published data or a durable ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LOOP_WORKFLOWS } from './loop-fleet-status.mjs';
import { buildIndependentFleetControlOutcome } from '../lib/independent-fleet-outcome.mjs';
import { findLoopPolicy, validateLoopRegistry } from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const DEFAULT_HEALTH_PATH = path.join('data', 'loop-fleet', 'ledger', 'loop-health-history.jsonl');
const DEFAULT_WINDOW_HOURS = 48;
const DEFAULT_MAX_RECORDS = 1000;

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

function readJson(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${file}`);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function readJsonl(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return { records: [], errors: [`health ledger is missing: ${file}`] };
  const records = [];
  const errors = [];
  for (const [index, line] of fs.readFileSync(absolute, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      errors.push(`health ledger line ${index + 1} is invalid JSON`);
    }
  }
  return { records, errors };
}

function listCompletedRuns({ repo, workflow }) {
  try {
    const raw = execFileSync('gh', [
      'run', 'list',
      '--repo', repo,
      '--workflow', workflow,
      '--branch', 'main',
      '--status', 'completed',
      '--limit', String(DEFAULT_MAX_RECORDS),
      '--json', 'databaseId,status,conclusion,createdAt,updatedAt,headSha,url',
    ], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runs = JSON.parse(raw);
    if (!Array.isArray(runs)) return { runs: [], error: `GitHub returned a non-array for ${workflow}` };
    return { runs, error: null };
  } catch {
    return { runs: [], error: `GitHub Actions run inventory unavailable for ${workflow}` };
  }
}

export function collectIndependentFleetOutcome({
  registryPath = DEFAULT_REGISTRY_PATH,
  healthPath = DEFAULT_HEALTH_PATH,
  repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPO || '',
  now = new Date(),
  windowHours = DEFAULT_WINDOW_HOURS,
  maxRecords = DEFAULT_MAX_RECORDS,
  listRunsImpl = listCompletedRuns,
} = {}) {
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const policy = findLoopPolicy(registry, 'L10');
  const health = readJsonl(healthPath);
  const sourceErrors = [...health.errors];
  const runs = [];
  if (!repo) {
    sourceErrors.push('GitHub repository is not configured');
  } else {
    for (const workflow of Object.values(LOOP_WORKFLOWS)) {
      const result = listRunsImpl({ repo, workflow });
      if (result.error) sourceErrors.push(result.error);
      runs.push(...(Array.isArray(result.runs) ? result.runs : []));
    }
  }
  const result = buildIndependentFleetControlOutcome({
    healthRecords: health.records,
    // Preserve malformed and duplicate rows so the reconciliation helper can
    // fail closed instead of silently turning a bad inventory into a clean one.
    githubRuns: runs,
    sourceErrors,
    now,
    windowHours,
    maxRecords,
    outcomeId: policy.outcome.outcomeId,
    primaryMetric: policy.primaryMetric,
    sourceRefs: policy.outcome.sourceRefs,
    allowNumeratorExceedDenominator: policy.outcome.allowNumeratorExceedDenominator,
  });
  return {
    ...result,
    registry: {
      path: registryPath,
      loopId: 'L10',
      sourceRefs: policy.outcome.sourceRefs,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const outputPath = valueAfter(argv, '--out');
  if (!outputPath) throw new Error('--out is required');
  const windowHours = Number(valueAfter(argv, '--window-hours', DEFAULT_WINDOW_HOURS));
  const maxRecords = Number(valueAfter(argv, '--max-records', DEFAULT_MAX_RECORDS));
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error('--window-hours must be positive');
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('--max-records must be a positive integer');
  const result = collectIndependentFleetOutcome({
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
    healthPath: valueAfter(argv, '--health', DEFAULT_HEALTH_PATH),
    repo: valueAfter(argv, '--repo', process.env.GITHUB_REPOSITORY || process.env.GH_REPO || ''),
    windowHours,
    maxRecords,
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    loopId: result.loopId,
    status: result.outcome.status,
    independent: result.outcome.independent,
    numerator: result.outcome.numerator,
    denominator: result.outcome.denominator,
    sourceErrors: result.metrics.sourceErrors,
    reconciliationErrors: result.metrics.reconciliationErrors,
  }));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[L10 independent outcome] ${error.message}`);
    process.exitCode = 1;
  }
}
