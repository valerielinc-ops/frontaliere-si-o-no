import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const gate = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-typecheck-baseline.mjs'), 'utf8');
const comparison = fs.readFileSync(path.join(ROOT, 'scripts/ci/compare-typecheck-heap.sh'), 'utf8');
const contract = fs.readFileSync(path.join(ROOT, 'scripts/ci/typecheck-heap-contract.env'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const heapFlagPattern = /--max[-_]old[-_]space[-_]size\b/iu;

const contractPaths = [
  'scripts/ci/check-typecheck-baseline.mjs',
  'scripts/ci/compare-typecheck-heap.sh',
  'scripts/ci/typecheck-heap-contract.env',
  'tests/typecheck-heap-comparison.test.ts',
];

function contractChangedOnPullRequest(): boolean {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    return false;
  }
  const base = process.env.GITHUB_BASE_REF;
  if (!base) throw new Error('GITHUB_BASE_REF assente nel confronto heap di una pull request');
  const diff = spawnSync('git', ['diff', '--name-only', `origin/${base}...HEAD`, '--', ...contractPaths], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (diff.status !== 0) {
    throw new Error(`diff del contratto heap non verificabile: ${diff.stderr || `exit ${diff.status}`}`);
  }
  return diff.stdout.trim().length > 0;
}

describe('typecheck heap comparison contract (#18199)', () => {
  it('lascia il limite heap al runner invece di sovrascriverlo nel processo figlio', () => {
    expect(gate).not.toMatch(heapFlagPattern);
    expect(gate).toContain('spawnSync(process.execPath, [TSC_BIN');
  });

  it('riconosce il flag heap con quoting, separatori e forme argomento diverse', () => {
    for (const form of [
      "'--max-old-space-size=12288'",
      '"--max-old-space-size 12288"',
      "'--max-old-space-size', '12288'",
      "'--max_old_space_size=12288'",
    ]) {
      expect(form).toMatch(heapFlagPattern);
    }
  });

  it('confronta old e new sullo stesso checkout con cache incrementale azzerata', () => {
    expect(contract).toContain('TYPECHECK_HISTORICAL_HEAP_MB=12288');
    expect(contract).toContain('TYPECHECK_CURRENT_HEAP_MB=10240');
    expect(comparison).toContain('source "$CONTRACT"');
    expect(comparison).toContain('OLD_HEAP_MB="$TYPECHECK_HISTORICAL_HEAP_MB"');
    expect(comparison).toContain('NEW_HEAP_MB="$TYPECHECK_CURRENT_HEAP_MB"');
    expect(comparison).toContain('rm -f "$BUILD_INFO"');
    expect(comparison.match(/npm run typecheck:gate/gu)).toHaveLength(1);
    expect(comparison).toContain('old_status');
    expect(comparison).toContain('new_status');
  });

  it('fallisce se una variante non passa o il nuovo RSS raggiunge il limite runner', () => {
    expect(comparison).toContain('[ "$old_status" -ne 0 ] || [ "$new_status" -ne 0 ]');
    expect(comparison).toContain('[ "$new_peak_mb" -ge "$runner_limit_mb" ]');
    expect(comparison).toContain('/sys/fs/cgroup/memory.max');
    expect(comparison).toContain('/proc/meminfo');
  });

  it('mantiene il limite ordinario del workflow uguale al contratto misurato', () => {
    const configured = contract.match(/^TYPECHECK_CURRENT_HEAP_MB=(\d+)$/mu)?.[1];
    const wired = workflow.match(/NODE_OPTIONS=--max-old-space-size=(\d+)[\s\\]+\n\s+bash scripts\/ci\/sample-mem-during\.sh -- npm run typecheck:gate/u)?.[1];
    expect(configured).toMatch(/^\d+$/u);
    expect(wired).toBe(configured);
  });

  it.runIf(contractChangedOnPullRequest())(
    'misura old e new sullo stesso runner e HEAD',
    () => {
      const result = spawnSync('bash', ['scripts/ci/compare-typecheck-heap.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /\[typecheck-heap-comparison\] old_status=0 old_peak_rss_mb=\d+ new_status=0 new_peak_rss_mb=\d+ runner_limit_mb=\d+ new_headroom_mb=[1-9]\d*/u,
      );
    },
    30 * 60 * 1000,
  );
});
