import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '..');
const workflow = YAML.parse(
  readFileSync(join(root, '.github/workflows/cleanup-stale-jobs.yml'), 'utf8'),
) as {
  jobs: { 'cleanup-stale-jobs': { steps: Array<{ name?: string; run?: string }> } };
};
const cleanupScript = workflow.jobs['cleanup-stale-jobs'].steps.find(
  (step) => step.name === 'Cleanup each per-crawler slice',
)?.run;
const tempRoots: string[] = [];

function fixture(sliceCount: number) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cleanup-stale-slices-'));
  tempRoots.push(fixtureRoot);
  const sliceDir = join(fixtureRoot, 'data/jobs/by-crawler');
  const stateDir = join(fixtureRoot, 'state');
  const binDir = join(fixtureRoot, 'bin');
  const runnerTemp = join(fixtureRoot, 'runner-temp');
  mkdirSync(sliceDir, { recursive: true });
  mkdirSync(join(fixtureRoot, 'scripts/lib'), { recursive: true });
  mkdirSync(stateDir);
  mkdirSync(binDir);
  mkdirSync(runnerTemp);
  copyFileSync(
    join(root, 'scripts/lib/bounded-parallel.sh'),
    join(fixtureRoot, 'scripts/lib/bounded-parallel.sh'),
  );
  writeFileSync(join(stateDir, 'active'), '0');
  writeFileSync(join(stateDir, 'max'), '0');
  for (let index = 0; index < sliceCount; index += 1) {
    writeFileSync(join(sliceDir, `crawler-${index}.json`), '{}\n');
  }

  const nodeStub = join(binDir, 'node');
  writeFileSync(nodeStub, `#!/bin/bash
set -euo pipefail
state="$CLEANUP_TEST_STATE"
lock="$state.lock"
while ! mkdir "$lock" 2>/dev/null; do sleep 0.002; done
active=$(cat "$state/active")
active=$((active + 1))
max=$(cat "$state/max")
if [ "$active" -gt "$max" ]; then printf '%s' "$active" > "$state/max"; fi
printf '%s' "$active" > "$state/active"
printf '%s\n' "$JOBS_SLICE_FILE" >> "$state/processed"
rmdir "$lock"
sleep 0.08
while ! mkdir "$lock" 2>/dev/null; do sleep 0.002; done
active=$(cat "$state/active")
printf '%s' "$((active - 1))" > "$state/active"
rmdir "$lock"
if [ "$(basename "$JOBS_SLICE_FILE")" = "\${CLEANUP_TEST_FAIL:-}" ]; then exit 7; fi
`);
  chmodSync(nodeStub, 0o755);
  return { fixtureRoot, stateDir, binDir, runnerTemp };
}

function runCleanup(
  fixtureData: ReturnType<typeof fixture>,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync('/bin/bash', ['-c', cleanupScript ?? 'exit 99'], {
    cwd: fixtureData.fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLEANUP_TEST_STATE: fixtureData.stateDir,
      PATH: `${fixtureData.binDir}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: fixtureData.runnerTemp,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const fixtureRoot of tempRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('cleanup stale job slice fan-out', () => {
  it('runs every slice with real concurrency capped at eight workers', () => {
    const fixtureData = fixture(12);

    const result = runCleanup(fixtureData);

    const max = Number(readFileSync(join(fixtureData.stateDir, 'max'), 'utf8'));
    const processed = readFileSync(join(fixtureData.stateDir, 'processed'), 'utf8')
      .trim()
      .split('\n');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(8);
    expect(new Set(processed).size).toBe(12);
    expect(result.stdout).toContain('Bounded parallel per-slice cleanup complete: 12 slice(s)');
  });

  it('runs all slices but fails before commit when any worker exits non-zero', () => {
    const fixtureData = fixture(4);

    const result = runCleanup(fixtureData, { CLEANUP_TEST_FAIL: 'crawler-0.json' });

    const processed = readFileSync(join(fixtureData.stateDir, 'processed'), 'utf8')
      .trim()
      .split('\n');
    expect(result.status).toBe(1);
    expect(new Set(processed).size).toBe(4);
    expect(result.stdout).toContain('Per-slice cleanup failed; refusing to commit a partial result.');
    expect(result.stdout).toContain('data/jobs/by-crawler/crawler-0.json');
  });
});
