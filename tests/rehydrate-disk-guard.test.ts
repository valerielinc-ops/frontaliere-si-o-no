// Coverage for scripts/lib/rehydrate-disk-guard.sh and its wiring into
// scripts/lib/rehydrate-section-shards.sh.
//
// validate-dist died on the runner's own ENOSPC (runs 36595840668 …
// 36830161110) or wedged until the 300-minute job timeout (36566812671,
// 36656159822, 36706643053): no step result, no gate row, so integrity-verdict
// could only say `__UNKNOWN__:dist`. These tests pin the replacement contract:
// a write that would cross the reserve is refused BEFORE it starts, dist/ is
// left exactly as it was, the first refusal is recorded, and the script exits
// non-zero with the reason named — while the real filesystem of the machine
// running the suite never matters, because `df` is stubbed on PATH.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SECTION = 'fixturesec';
const IT_SLUG = 'sezione-fixture';
const OTHER_SLUGS: Record<string, string> = {
  en: 'fixture-section',
  de: 'fixture-sektion',
  fr: 'section-fixture',
};
const PAGE = '<!DOCTYPE html><html><head><title>p</title></head><body>p</body></html>';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function write(p: string, body: string): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body, 'utf8');
}

/** A `df` that reports `FAKE_DF_AVAIL_KB` free on a fake mount, POSIX form. */
function stubDf(root: string): string {
  const bin = join(root, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const df = join(bin, 'df');
  writeFileSync(
    df,
    '#!/bin/sh\n' +
      'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\n' +
      'echo "fakefs 150000000 140000000 ${FAKE_DF_AVAIL_KB} 99% /fake"\n',
  );
  chmodSync(df, 0o755);
  return bin;
}

function runGuardSnippet(snippet: string, env: Record<string, string>): { status: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'disk-guard-'));
  roots.push(root);
  const bin = stubDf(root);
  try {
    const out = execFileSync(
      'bash',
      ['-c', `set -u; . "${resolve('scripts/lib/rehydrate-disk-guard.sh')}"; ${snippet}`],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, ...env },
      },
    );
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('rehydrate-disk-guard.sh', () => {
  it('admits a write that leaves the reserve intact', () => {
    const r = runGuardSnippet('rehydrate_disk_guard "x" 1024 . && echo ADMITTED', {
      FAKE_DF_AVAIL_KB: String(10 * 1024 * 1024),
      REHYDRATE_DISK_RESERVE_MB: '4096',
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('ADMITTED');
  });

  it('refuses a write that would cross the reserve, and the FIRST refusal wins the marker', () => {
    const r = runGuardSnippet(
      'rehydrate_disk_guard "ticino fr tar extraction" 9000000 . || echo REFUSED; ' +
        'rehydrate_disk_guard "zurigo fr tar extraction" 9000000 . || true; ' +
        'rehydrate_disk_exhausted && cat "$REHYDRATE_DISK_GUARD_FILE"',
      { FAKE_DF_AVAIL_KB: String(8 * 1024 * 1024), REHYDRATE_DISK_RESERVE_MB: '4096' },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('REFUSED');
    expect(r.out).toMatch(/::error::\[disk-guard\] ticino fr tar extraction needs ~8789 MB/);
    expect(r.out).toMatch(/^ticino fr tar extraction need_mb=8789 avail_mb=8192 reserve_mb=4096 mount=\/fake$/m);
    // The second refusal is still reported, but does not overwrite the marker.
    expect(r.out).toMatch(/::error::\[disk-guard\] zurigo fr tar extraction/);
    expect(r.out).not.toMatch(/^zurigo fr tar extraction need_mb=/m);
  });

  it('fails OPEN on measurement only: an unreadable df never invents a failure', () => {
    const r = runGuardSnippet('rehydrate_disk_guard "x" 999999999 . && echo ADMITTED', {
      FAKE_DF_AVAIL_KB: 'not-a-number',
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('ADMITTED');
  });
});

/**
 * The real section script against a throwaway root (same shape as
 * tests/rehydrate-trunk-guard.test.ts): one live section whose IT subtree
 * arrives as a batch tar, non-IT locales already complete.
 */
function runSection(availKb: number): { status: number; out: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'disk-guard-section-'));
  roots.push(root);
  const lib = join(root, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const f of [
    'rehydrate-section-shards.sh',
    'rehydrate-trunk-guard.sh',
    'rehydrate-disk-guard.sh',
    'bounded-parallel.sh',
  ]) {
    copyFileSync(resolve('scripts/lib', f), join(lib, f));
  }
  writeFileSync(join(lib, 'section-shard-slugs.json'), JSON.stringify({ [SECTION]: { it: IT_SLUG, ...OTHER_SLUGS } }));
  writeFileSync(join(lib, 'section-shard-batches.json'), JSON.stringify({ [SECTION]: 1 }));
  writeFileSync(join(lib, 'section-shard-owners.json'), JSON.stringify({ [SECTION]: 'test-owner' }));

  // Trunk content under the section prefix (no index.html, so the section is
  // NOT skipped as complete): a refusal must leave it untouched.
  write(join(root, 'dist', IT_SLUG, 'trunk-only', 'index.html'), PAGE);
  for (const [loc, slug] of Object.entries(OTHER_SLUGS)) write(join(root, 'dist', loc, slug, 'index.html'), PAGE);

  const stage = join(root, 'stage');
  write(join(stage, IT_SLUG, 'index.html'), PAGE);
  write(join(stage, IT_SLUG, 'trunk-only', 'index.html'), PAGE);
  const runnerTemp = join(root, 'runner-temp');
  const dl = join(runnerTemp, 'shard-batch-1-dist-it');
  mkdirSync(dl, { recursive: true });
  execFileSync('tar', ['-C', stage, '-cf', join(dl, `${SECTION}-dist-it.tar`), IT_SLUG]);
  writeFileSync(join(runnerTemp, 'shard-batch-1-dist-it.done'), '');

  const bin = stubDf(root);
  try {
    const out = execFileSync('bash', ['scripts/lib/rehydrate-section-shards.sh'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DF_AVAIL_KB: String(availKb),
        REHYDRATE_DISK_RESERVE_MB: '4096',
        RUNNER_TEMP: runnerTemp,
        DEPLOY_RUN_ID: '0',
        GH_TOKEN: 'unused',
        FIXTURESEC_SHARD_LIVE: 'true',
      },
    });
    return { status: 0, out, root };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, root };
  }
}

describe('rehydrate-section-shards.sh — disk guard wiring', () => {
  it('refuses the extraction before touching dist/, names the reason, and exits non-zero', () => {
    const { status, out, root } = runSection(1024); // 1 MiB free < 4 GiB reserve
    expect(status).toBe(1);
    expect(out).toMatch(/::error::\[disk-guard\] fixturesec it tar extraction needs/);
    expect(out).toContain('section shard rehydrate stopped before ENOSPC');
    // No trunk_replace_begin ran: the trunk copy is still there, the shard
    // copy was never written.
    expect(existsSync(join(root, 'dist', IT_SLUG, 'trunk-only', 'index.html'))).toBe(true);
    expect(existsSync(join(root, 'dist', IT_SLUG, 'index.html'))).toBe(false);
    expect(readFileSync(join(root, 'runner-temp', 'rehydrate-disk-exhausted'), 'utf8')).toMatch(
      /^fixturesec it tar extraction need_mb=\d+ avail_mb=1 reserve_mb=4096 mount=\/fake$/m,
    );
    // The refused transport is reclaimed after the fan-out joins.
    expect(existsSync(join(root, 'runner-temp', 'shard-batch-1-dist-it'))).toBe(false);
  });

  it('with room to spare, rehydrates as before and reclaims the empty batch transport', () => {
    const { status, out, root } = runSection(100 * 1024 * 1024); // 100 GiB free
    expect(status, out).toBe(0);
    expect(out).toContain('rehydrated fixturesec it from tar artifact');
    expect(existsSync(join(root, 'dist', IT_SLUG, 'index.html'))).toBe(true);
    expect(existsSync(join(root, 'runner-temp', 'rehydrate-disk-exhausted'))).toBe(false);
    expect(existsSync(join(root, 'runner-temp', 'shard-batch-1-dist-it'))).toBe(false);
    expect(existsSync(join(root, 'runner-temp', 'shard-batch-1-dist-it.done'))).toBe(false);
  });
});
