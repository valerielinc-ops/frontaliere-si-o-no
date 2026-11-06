import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = execFileSync('git', ['show', 'HEAD:.github/workflows/loop-fleet-ledger.yml'], { encoding: 'utf8' });
const benchmark = execFileSync('git', ['show', 'HEAD:scripts/ci/benchmark-loop-fleet-ledger.mjs'], { encoding: 'utf8' });

describe('FU-2026-10-17-007 — durable loop-fleet ledger benchmark', () => {
  it('only benchmarks after an immutable source artifact is available', () => {
    expect(workflow).toContain('Download immutable source artifact');
    expect(workflow).toContain('steps.source_artifact.outputs.available == \'true\'');
    expect(workflow).toContain('benchmark-loop-fleet-ledger.mjs');
    expect(workflow).toContain('ledger/loop-fleet');
  });

  it('requires a three-run comparable window and rejects rewrites/regressions', () => {
    expect(benchmark).toContain('const REQUIRED_COMPARABLE_RUNS = 3;');
    expect(benchmark).toContain('latency-regression-over-10pct');
    expect(benchmark).toContain('canonical-rewrite-detected');
    expect(benchmark).toContain('contract: \'three-comparable-runs-before-after-v1\'');
  });
});
