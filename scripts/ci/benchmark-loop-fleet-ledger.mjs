#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const WORKFLOW = 'loop-fleet-ledger';
const REQUIRED_COMPARABLE_RUNS = 3;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function requireRunId(value, label) {
  if (!/^\d+$/u.test(String(value ?? ''))) {
    throw new Error(`${label} must be numeric`);
  }
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/iu.test(String(value ?? ''))) {
    throw new Error(`${label} must be a 40-character SHA`);
  }
}

function requireDigest(value, label) {
  if (!/^[0-9a-f]{64}$/iu.test(String(value ?? ''))) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
}

/** Validate the immutable per-run benchmark written by the ledger bridge. */
export function validateLedgerBenchmark(value, label = 'ledger benchmark') {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (value.schema_version !== SCHEMA_VERSION) throw new Error(`${label} has unsupported schema_version`);
  if (value.workflow !== WORKFLOW) throw new Error(`${label} belongs to ${value.workflow || 'unknown'} workflow`);
  requireRunId(value.workflow_run_id, `${label}.workflow_run_id`);
  requireRunId(value.source_run_id, `${label}.source_run_id`);
  if (!/^L\d+$/u.test(String(value.source_loop ?? ''))) throw new Error(`${label}.source_loop is invalid`);
  requireSha(value.source_sha, `${label}.source_sha`);
  if (value.ledger_branch !== 'ledger/loop-fleet') throw new Error(`${label}.ledger_branch is invalid`);
  if (!['appended', 'already-present', 'canonical-rewrite-detected'].includes(value.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!isObject(value.trusted)
    || value.trusted.source_provenance !== 'validated-main-run'
    || value.trusted.measurement !== 'ledger-worktree'
    || value.trusted.canonical_snapshot !== 'sha256') {
    throw new Error(`${label} is missing the trusted measurement contract`);
  }
  if (!Number.isFinite(Date.parse(String(value.recorded_at ?? '')))) {
    throw new Error(`${label}.recorded_at is invalid`);
  }
  for (const field of [
    'bytes_before',
    'bytes_after',
    'canonical_bytes_before',
    'canonical_bytes_after',
    'append_duration_ms',
  ]) requireNonNegativeNumber(value[field], `${label}.${field}`);
  requireNonNegativeInteger(value.canonical_rewrite_count, `${label}.canonical_rewrite_count`);
  requireDigest(value.canonical_digest_before, `${label}.canonical_digest_before`);
  requireDigest(value.canonical_digest_after, `${label}.canonical_digest_after`);
  if (!Array.isArray(value.attempt_durations_ms) || value.attempt_durations_ms.length === 0) {
    throw new Error(`${label}.attempt_durations_ms must be a non-empty array`);
  }
  value.attempt_durations_ms.forEach((duration, index) => {
    requireNonNegativeNumber(duration, `${label}.attempt_durations_ms[${index}]`);
  });
  return value;
}

function benchmarkKey(value) {
  return `${value.workflow}|${value.ledger_branch}|${value.source_loop}|${value.schema_version}`;
}

function recordedAtMs(value) {
  const timestamp = Date.parse(value.recorded_at);
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

/** Nearest-rank p95; with three runs this is deliberately the slowest run. */
export function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function uniqueNewestFirst(values) {
  const byRun = new Map();
  for (const value of values) {
    const previous = byRun.get(String(value.workflow_run_id));
    if (!previous || recordedAtMs(value) > recordedAtMs(previous)) byRun.set(String(value.workflow_run_id), value);
  }
  return [...byRun.values()].sort((left, right) => {
    const timeDelta = recordedAtMs(left) - recordedAtMs(right);
    return timeDelta || String(left.workflow_run_id).localeCompare(String(right.workflow_run_id));
  });
}

function windowDetails(values) {
  return {
    run_count: values.length,
    run_ids: values.map((value) => String(value.workflow_run_id)),
    append_p95_ms: percentile95(values.map((value) => value.append_duration_ms)),
    rows: values.map((value) => ({
      workflow_run_id: String(value.workflow_run_id),
      source_run_id: String(value.source_run_id),
      source_sha: String(value.source_sha).toLowerCase(),
      bytes_before: value.bytes_before,
      bytes_after: value.bytes_after,
      append_duration_ms: value.append_duration_ms,
      canonical_rewrite_count: value.canonical_rewrite_count,
    })),
  };
}

/**
 * Compare the newest three trusted appends with the preceding three appends
 * of the same loop and contract. A single window is enough to publish a p95;
 * two windows are required before claiming a latency regression.
 *
 * The p95 is deliberately retained as a descriptive metric, but it is not a
 * sufficient alarm on its own when a window contains only three observations:
 * nearest-rank p95 is then the maximum, so one slow hosted runner can make an
 * otherwise healthy window look regressed. The failure verdict therefore also
 * requires every sample in the post-change window to clear the same 10%
 * threshold against the preceding p95.
 */
export function buildLedgerBenchmarkSummary(current, history = []) {
  const currentValue = validateLedgerBenchmark(current, 'current ledger benchmark');
  const validHistory = history.map((value, index) => validateLedgerBenchmark(value, `history[${index}]`));
  const key = benchmarkKey(currentValue);
  const family = uniqueNewestFirst([currentValue, ...validHistory])
    .filter((value) => benchmarkKey(value) === key);
  const comparable = family.filter((value) => value.status === 'appended');
  const afterValues = comparable.slice(-REQUIRED_COMPARABLE_RUNS);
  const beforeValues = comparable.length >= REQUIRED_COMPARABLE_RUNS * 2
    ? comparable.slice(-REQUIRED_COMPARABLE_RUNS * 2, -REQUIRED_COMPARABLE_RUNS)
    : [];
  const before = windowDetails(beforeValues);
  const after = windowDetails(afterValues);
  const preChangeP95 = before.append_p95_ms;
  const postChangeP95 = after.append_p95_ms;
  const latencyRegressionPct = preChangeP95 !== null && preChangeP95 > 0 && postChangeP95 !== null
    ? ((postChangeP95 - preChangeP95) / preChangeP95) * 100
    : null;
  const latencyRegressionOver10Pct = latencyRegressionPct === null
    ? null
    : afterValues.length === REQUIRED_COMPARABLE_RUNS
      && afterValues.every((value) => value.append_duration_ms > preChangeP95 * 1.1);
  const rewriteFindings = family
    .filter((value) => value.canonical_rewrite_count > 0)
    .map((value) => ({
      workflow_run_id: String(value.workflow_run_id),
      source_run_id: String(value.source_run_id),
      source_loop: value.source_loop,
      canonical_rewrite_count: value.canonical_rewrite_count,
    }));
  const canonicalRewriteCount = rewriteFindings
    .reduce((total, value) => total + value.canonical_rewrite_count, 0);

  let verdict = 'awaiting-three-comparable-runs';
  if (rewriteFindings.length > 0) verdict = 'canonical-rewrite-detected';
  else if (afterValues.length === REQUIRED_COMPARABLE_RUNS && beforeValues.length < REQUIRED_COMPARABLE_RUNS) {
    verdict = 'three-run-post-change-window-ready';
  } else if (latencyRegressionOver10Pct === true) {
    verdict = 'latency-regression-over-10pct';
  } else if (afterValues.length === REQUIRED_COMPARABLE_RUNS) {
    verdict = 'trusted-benchmark-green';
  }

  return {
    schema_version: SCHEMA_VERSION,
    workflow: WORKFLOW,
    trusted: true,
    contract: 'three-comparable-runs-before-after-v1',
    source_loop: currentValue.source_loop,
    ledger_branch: currentValue.ledger_branch,
    required_comparable_runs: REQUIRED_COMPARABLE_RUNS,
    comparable_run_count: comparable.length,
    before,
    after,
    pre_change_append_p95_ms: preChangeP95,
    post_change_append_p95_ms: postChangeP95,
    latency_regression_pct: latencyRegressionPct,
    latency_regression_over_10pct: latencyRegressionOver10Pct,
    canonical_rewrite_count: canonicalRewriteCount,
    canonical_rewrite_findings: rewriteFindings,
    verdict,
  };
}

function findBenchmarkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return path.basename(root) === 'ledger-append.json' ? [root] : [];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findBenchmarkFiles(path.join(root, entry.name)));
}

function readHistory(root) {
  const values = [];
  const invalid = [];
  for (const file of findBenchmarkFiles(root)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      values.push(validateLedgerBenchmark(parsed, file));
    } catch (error) {
      invalid.push({ file, error: error.message });
    }
  }
  return { values, invalid };
}

function formatMetric(value, suffix = '') {
  return value === null || value === undefined ? 'pending' : `${Number(value).toFixed(3)}${suffix}`;
}

function summaryMarkdown(summary, invalidHistoryCount) {
  const lines = [
    '## Trusted loop-fleet ledger benchmark',
    '',
    `- Verdict: **${summary.verdict}**`,
    `- Source loop: \u0060${summary.source_loop}\u0060; comparable appends: ${summary.comparable_run_count}/${summary.required_comparable_runs} required`,
    `- Before-window append p95: **${formatMetric(summary.pre_change_append_p95_ms, ' ms')}**`,
    `- After-window append p95: **${formatMetric(summary.post_change_append_p95_ms, ' ms')}**`,
    `- Sustained latency regression over 10%: **${summary.latency_regression_over_10pct === null ? 'pending baseline' : summary.latency_regression_over_10pct ? 'YES' : 'no'}**`,
    `- Canonical rewrites: **${summary.canonical_rewrite_count}**`,
  ];
  if (invalidHistoryCount > 0) lines.push(`- Invalid historical benchmark artifacts ignored: ${invalidHistoryCount}`);
  if (summary.canonical_rewrite_findings.length > 0) {
    lines.push('', 'Canonical rewrite findings (every non-zero run):');
    for (const finding of summary.canonical_rewrite_findings) {
      lines.push(`- run \u0060${finding.workflow_run_id}\u0060 / source \u0060${finding.source_run_id}\u0060 (${finding.source_loop}): canonical_rewrite_count=${finding.canonical_rewrite_count}`);
    }
  }
  lines.push('', '| workflow run | source run | bytes before → after | append duration | canonical rewrites |', '| --- | --- | ---: | ---: | ---: |');
  for (const row of summary.after.rows) {
    lines.push(`| ${row.workflow_run_id} | ${row.source_run_id} | ${row.bytes_before} → ${row.bytes_after} | ${formatMetric(row.append_duration_ms, ' ms')} | ${row.canonical_rewrite_count} |`);
  }
  return `${lines.join('\n')}\n`;
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2) } = {}) {
  const currentPath = valueAfter(argv, '--current');
  const historyDir = valueAfter(argv, '--history-dir');
  const outputPath = valueAfter(argv, '--output');
  const summaryPath = valueAfter(argv, '--summary');
  if (!currentPath || !outputPath) throw new Error('--current and --output are required');
  const current = validateLedgerBenchmark(JSON.parse(fs.readFileSync(currentPath, 'utf8')), currentPath);
  const history = readHistory(historyDir);
  const summary = buildLedgerBenchmarkSummary(current, history.values);
  summary.invalid_history_count = history.invalid.length;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summaryPath) {
    fs.mkdirSync(path.dirname(path.resolve(summaryPath)), { recursive: true });
    fs.appendFileSync(summaryPath, summaryMarkdown(summary, history.invalid.length));
  }
  if (summary.canonical_rewrite_count > 0 || summary.latency_regression_over_10pct === true) {
    process.exitCode = 1;
  }
  return summary;
}

if ((() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-ledger-benchmark] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
