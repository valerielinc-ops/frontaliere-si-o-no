import { describe, expect, it } from 'vitest';
import {
  buildLedgerBenchmarkSummary,
  percentile95,
  validateLedgerBenchmark,
} from '../scripts/ci/benchmark-loop-fleet-ledger.mjs';

const SOURCE_SHA = '0123456789012345678901234567890123456789';
const DIGEST = 'a'.repeat(64);

function benchmark(
  workflowRunId: number,
  appendDurationMs: number,
  { status = 'appended', canonicalRewriteCount = 0, sourceLoop = 'L1' } = {},
) {
  return {
    schema_version: 1,
    workflow: 'loop-fleet-ledger',
    trusted: {
      source_provenance: 'validated-main-run',
      measurement: 'ledger-worktree',
      canonical_snapshot: 'sha256',
    },
    workflow_run_id: String(workflowRunId),
    source_loop: sourceLoop,
    source_run_id: String(10_000 + workflowRunId),
    source_sha: SOURCE_SHA,
    ledger_branch: 'ledger/loop-fleet',
    status,
    recorded_at: new Date(workflowRunId * 1_000).toISOString(),
    bytes_before: 100,
    bytes_after: status === 'appended' ? 120 : 100,
    canonical_bytes_before: 100,
    canonical_bytes_after: 100,
    canonical_digest_before: DIGEST,
    canonical_digest_after: DIGEST,
    canonical_rewrite_count: canonicalRewriteCount,
    append_duration_ms: appendDurationMs,
    attempt_durations_ms: [appendDurationMs],
  };
}

describe('loop-fleet ledger benchmark', () => {
  it('uses the slowest run as the nearest-rank p95 for a three-run window', () => {
    expect(percentile95([12, 7, 9])).toBe(12);
  });

  it('publishes the post-change p95 after three trusted comparable appends', () => {
    const current = benchmark(3, 30);
    const summary = buildLedgerBenchmarkSummary(current, [benchmark(1, 10), benchmark(2, 20)]);

    expect(summary).toMatchObject({
      verdict: 'three-run-post-change-window-ready',
      comparable_run_count: 3,
      post_change_append_p95_ms: 30,
      pre_change_append_p95_ms: null,
      latency_regression_over_10pct: null,
      canonical_rewrite_count: 0,
    });
    expect(summary.after.rows.map((row) => row.workflow_run_id)).toEqual(['1', '2', '3']);
  });

  it('compares two three-run windows and flags a latency increase above ten percent', () => {
    const current = benchmark(6, 122);
    const summary = buildLedgerBenchmarkSummary(current, [
      benchmark(1, 100),
      benchmark(2, 101),
      benchmark(3, 99),
      benchmark(4, 120),
      benchmark(5, 121),
    ]);

    expect(summary).toMatchObject({
      verdict: 'latency-regression-over-10pct',
      pre_change_append_p95_ms: 101,
      post_change_append_p95_ms: 122,
      latency_regression_over_10pct: true,
    });
  });

  it('does not promote one slow hosted runner to a sustained regression', () => {
    const current = benchmark(6, 160);
    const summary = buildLedgerBenchmarkSummary(current, [
      benchmark(1, 100),
      benchmark(2, 101),
      benchmark(3, 99),
      benchmark(4, 100),
      benchmark(5, 101),
    ]);

    expect(summary).toMatchObject({
      verdict: 'trusted-benchmark-green',
      pre_change_append_p95_ms: 101,
      post_change_append_p95_ms: 160,
      latency_regression_pct: expect.closeTo(58.4158, 4),
      latency_regression_over_10pct: false,
    });
  });

  it('reports every non-zero canonical rewrite instead of hiding it in the aggregate', () => {
    const current = benchmark(3, 30, { canonicalRewriteCount: 1 });
    const summary = buildLedgerBenchmarkSummary(current, [
      benchmark(1, 10, { canonicalRewriteCount: 2 }),
      benchmark(2, 20),
    ]);

    expect(summary.verdict).toBe('canonical-rewrite-detected');
    expect(summary.canonical_rewrite_count).toBe(3);
    expect(summary.canonical_rewrite_findings.map((finding) => finding.workflow_run_id)).toEqual(['1', '3']);
  });

  it('fails closed when a per-run record is not trusted or complete', () => {
    const invalid = { ...benchmark(1, 10), trusted: undefined };
    expect(() => validateLedgerBenchmark(invalid)).toThrow(/trusted measurement contract/);
  });
});
