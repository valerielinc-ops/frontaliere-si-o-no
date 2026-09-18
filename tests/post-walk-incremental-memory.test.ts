import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'scripts/dev/bench-post-walk-incremental-memory.mjs');

describe('post-walk incremental memory benchmark', () => {
  it('bounds the 700k-entry/1.5M-path retained heap with a 20% budget margin', { timeout: 180_000 }, () => {
    const output = execFileSync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', BENCHMARK, '--json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          POST_WALK_BENCH_ENTRIES: '700000',
          POST_WALK_BENCH_SCAN_PATHS: '1500000',
        },
      },
    );
    const report = JSON.parse(output.trim());

    expect(report.entryCount).toBe(700_000);
    expect(report.scanPathCount).toBe(1_500_000);
    expect(report.aliasFraction).toBe(0.3);
    expect(report.aliasCount).toBe(210_000);
    expect(report.streaming.plan.mode).toBe('incremental');
    // The bounded planner dispatches only the changed entries (7,000) and
    // their affected aliases (7,000); the old >100k assertion described the
    // pre-#9100 whole-corpus selection and made the benchmark fail on the
    // current planner before this task touched it.
    expect(report.streaming.plan.processed).toBe(14_000);
    expect(report.streaming.peakRetainedMB).toBeLessThan(report.legacy.peakRetainedMB);
    expect(report.streaming.peakRetainedMB).toBeLessThanOrEqual(report.budget.maxRetainedHeapMB);
    expect(report.budget.margin).toBe('20%');
  });
});
